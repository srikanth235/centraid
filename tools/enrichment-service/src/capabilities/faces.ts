import { existsSync } from "node:fs";
import path from "node:path";

import { MODELS_DIR } from "../config.js";
import {
  computeSimilarityTransform,
  decodeYuNetLevel,
  SFACE_TEMPLATE_112,
  warpAffine,
} from "../face-geometry.js";
import type { DecodedFace } from "../face-geometry.js";
import { roundAndClampBox, scaleBoxToOriginal } from "../image-geometry.js";
import { nonMaxSuppression } from "../nms.js";
import { getOrCreateSession, loadOnnxRuntime } from "../onnx.js";
import {
  decodeImage,
  decodeImageResized,
  normalizeImageNet,
} from "../preprocess.js";
import type {
  FaceDetection,
  FacesItem,
  FacesResult,
  ItemResult,
  ModelId,
} from "../types.js";

// YuNet detection + SFace recognition (OpenCV Zoo, MIT + Apache-2.0
// respectively — see LICENSES.md), both natively ONNX.
export const FACES_MODEL_ID: ModelId = "yunet-sface@1";

const FACES_DIR = path.join(MODELS_DIR, "faces");
const YUNET_MODEL_PATH = path.join(FACES_DIR, "yunet.onnx");
const SFACE_MODEL_PATH = path.join(FACES_DIR, "sface.onnx");

const YUNET_INPUT_SIZE = 320;
const YUNET_STRIDES = [8, 16, 32] as const;
const YUNET_SCORE_THRESHOLD = 0.6;
const YUNET_NMS_IOU = 0.3;
const SFACE_INPUT_SIZE = 112;

export function facesWeightsPresent(): boolean {
  return [YUNET_MODEL_PATH, SFACE_MODEL_PATH].every(existsSync);
}

/**
 * Runs the YuNet detector over a fixed YUNET_INPUT_SIZE square input and
 * decodes its three stride levels (8/16/32) via decodeYuNetLevel, then
 * applies NMS across the concatenated detections. INTEGRATOR NOTE: the
 * per-level output tensor names/order and the exact score/box/landmark
 * tensor layout have not been validated against a real forward pass in
 * this environment (no onnxruntime-node install here) — this assumes
 * `session.outputNames` is ordered `[scores8, boxes8, landmarks8, scores16,
 * ...]` in stride order, which must be confirmed against the actual
 * downloaded face_detection_yunet_2023mar.onnx before trusting detections.
 */
async function detectFaces(
  pixelData: Float32Array,
  imageSize: number
): Promise<DecodedFace[]> {
  const ort = await loadOnnxRuntime();
  const session = await getOrCreateSession(YUNET_MODEL_PATH);
  const inputName = session.inputNames[0] ?? "input";
  const fetches = await session.run({
    [inputName]: new ort.Tensor("float32", pixelData, [
      1,
      3,
      imageSize,
      imageSize,
    ]),
  });

  const outputs = session.outputNames
    .map((name) => fetches[name]?.data)
    .filter(Boolean);
  const all: DecodedFace[] = [];

  YUNET_STRIDES.forEach((stride, levelIndex) => {
    const gridSize = imageSize / stride;
    const scores = outputs[levelIndex * 3];
    const boxes = outputs[levelIndex * 3 + 1];
    const landmarks = outputs[levelIndex * 3 + 2];
    if (!scores || !boxes) {
      return;
    }
    all.push(
      ...decodeYuNetLevel(
        {
          stride,
          gridWidth: gridSize,
          gridHeight: gridSize,
          scores: scores as ArrayLike<number>,
          boxes: boxes as ArrayLike<number>,
          landmarks: landmarks as ArrayLike<number> | undefined,
        },
        YUNET_SCORE_THRESHOLD
      )
    );
  });

  const suppressed = nonMaxSuppression(
    all.map((face) => ({ box: face.box, score: face.score })),
    { iouThreshold: YUNET_NMS_IOU }
  );
  const keptBoxes = new Set(suppressed.map((s) => s.box));
  return all.filter((face) => keptBoxes.has(face.box));
}

async function embedFace(alignedPixels: Float32Array): Promise<number[]> {
  const ort = await loadOnnxRuntime();
  const session = await getOrCreateSession(SFACE_MODEL_PATH);
  const inputName = session.inputNames[0] ?? "data";
  const fetches = await session.run({
    [inputName]: new ort.Tensor("float32", alignedPixels, [
      1,
      3,
      SFACE_INPUT_SIZE,
      SFACE_INPUT_SIZE,
    ]),
  });
  const outputName = session.outputNames[0];
  const data = outputName ? fetches[outputName]?.data : undefined;
  if (!data || !(data instanceof Float32Array)) {
    throw new Error("faces: SFace did not return a float32 embedding");
  }
  return Array.from(data);
}

export async function faces(item: FacesItem): Promise<ItemResult<FacesResult>> {
  try {
    const bytes = Buffer.from(item.bytes, "base64");
    const native = await decodeImage(bytes);
    const resized = await decodeImageResized(
      bytes,
      YUNET_INPUT_SIZE,
      YUNET_INPUT_SIZE
    );
    const pixelData = normalizeImageNet(resized);

    const detections = await detectFaces(pixelData, YUNET_INPUT_SIZE);

    const scaleX = native.width / YUNET_INPUT_SIZE;
    const scaleY = native.height / YUNET_INPUT_SIZE;
    const declaredDims =
      item.originalWidth && item.originalHeight
        ? { width: item.originalWidth, height: item.originalHeight }
        : { width: native.width, height: native.height };

    // Promise.all rather than a for-await loop: each detection's alignment
    // + SFace embedding is independent of every other, so there is no
    // reason to serialize them.
    const perDetection = await Promise.all(
      detections
        .filter((detection) => detection.landmarks)
        .map(async (detection): Promise<FaceDetection | undefined> => {
          const landmarks = detection.landmarks as NonNullable<
            typeof detection.landmarks
          >;
          const landmarksInNative = landmarks.map((p) => ({
            x: p.x * scaleX,
            y: p.y * scaleY,
          }));
          const transform = computeSimilarityTransform(
            landmarksInNative,
            SFACE_TEMPLATE_112
          );
          const aligned = warpAffine(
            native,
            transform,
            SFACE_INPUT_SIZE,
            SFACE_INPUT_SIZE
          );
          const alignedPixels = normalizeImageNet(aligned);
          const embedding = await embedFace(alignedPixels);

          const boxInNative = {
            x: detection.box.x * scaleX,
            y: detection.box.y * scaleY,
            width: detection.box.width * scaleX,
            height: detection.box.height * scaleY,
          };
          // roundAndClampBox (not plain rounding) guarantees this box can
          // never overshoot the item's declared dimensions — the gateway
          // client rejects a box that does (see its own doc comment).
          const finalBox = roundAndClampBox(
            scaleBoxToOriginal(boxInNative, native, declaredDims),
            declaredDims.width,
            declaredDims.height
          );
          if (finalBox[2] <= 0 || finalBox[3] <= 0) {
            return undefined;
          }

          return { box: finalBox, confidence: detection.score, embedding };
        })
    );

    const results: FaceDetection[] = perDetection.filter(
      (face): face is FaceDetection => face !== undefined
    );
    return { id: item.id, faces: results };
  } catch (error) {
    return {
      id: item.id,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
