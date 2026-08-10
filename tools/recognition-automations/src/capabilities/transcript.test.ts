import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import {
  resetTranscriptRuntimeForTests,
  setTranscriptRuntimeForTests,
  transcript,
  transcriptWeightsPresent,
} from "./transcript.js";

const REQUIRED_FILES = [
  "added_tokens.json",
  "config.json",
  "generation_config.json",
  "merges.txt",
  "normalizer.json",
  "preprocessor_config.json",
  "special_tokens_map.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "vocab.json",
  "onnx/encoder_model_quantized.onnx",
  "onnx/decoder_model_merged_quantized.onnx",
];

function pcm(...samples: number[]): Buffer {
  return Buffer.from(new Float32Array(samples).buffer);
}

describe("self-contained transcript capability", () => {
  afterEach(() => resetTranscriptRuntimeForTests());

  it("reports availability only when the complete pinned model is present", () => {
    const models = tempDirSync("centraid-transcript-model-");
    expect(transcriptWeightsPresent(models)).toBe(false);
    for (const file of REQUIRED_FILES) {
      const target = path.join(models, "transcript", file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, file);
    }
    expect(transcriptWeightsPresent(models)).toBe(true);
  });

  it("decodes audio and video through bounded FFmpeg pipes and caches Whisper", async () => {
    const ffmpegCalls: Array<{
      executable: string;
      args: string[];
      input: Buffer;
      maxBuffer: number;
    }> = [];
    let modelLoads = 0;
    setTranscriptRuntimeForTests({
      ffmpegPath: async () => "/runtime/ffmpeg",
      runFfmpeg: (executable, args, options) => {
        ffmpegCalls.push({ executable, args, ...options });
        return { status: 0, stdout: pcm(0.25, -0.25), stderr: Buffer.alloc(0) };
      },
      createTranscriber: async () => {
        modelLoads += 1;
        return async (audio) => ({ text: ` heard ${audio.length} samples ` });
      },
    });

    await expect(
      transcript({ id: "audio", mediaType: "audio/wav", bytes: "YQ==" })
    ).resolves.toStrictEqual({ id: "audio", text: "heard 2 samples" });
    await expect(
      transcript({ id: "video", mediaType: "video/mp4", bytes: "dg==" })
    ).resolves.toStrictEqual({ id: "video", text: "heard 2 samples" });

    expect(modelLoads).toBe(1);
    expect(ffmpegCalls).toHaveLength(2);
    expect(ffmpegCalls[0]).toMatchObject({
      executable: "/runtime/ffmpeg",
      input: Buffer.from("a"),
    });
    expect(ffmpegCalls[0]!.args).toStrictEqual(
      expect.arrayContaining(["-t", "600", "-vn", "-ac", "1", "-ar", "16000"])
    );
    expect(ffmpegCalls[0]!.maxBuffer).toBeLessThanOrEqual(40 * 1024 * 1024);
  });

  it("rejects non-AV inputs before loading native dependencies", async () => {
    let touched = false;
    setTranscriptRuntimeForTests({
      ffmpegPath: async () => {
        touched = true;
        return "/runtime/ffmpeg";
      },
    });
    await expect(
      transcript({ id: "image", mediaType: "image/png", bytes: "aQ==" })
    ).resolves.toStrictEqual({
      id: "image",
      error: "transcript: unsupported media type image/png",
    });
    expect(touched).toBe(false);
  });

  it.each([
    {
      name: "decode error",
      result: {
        status: 1,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from("bad media"),
      },
      error: "transcript: FFmpeg decode failed: bad media",
    },
    {
      name: "empty decode",
      result: { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) },
      error: "transcript: decoded audio is empty",
    },
    {
      name: "unaligned decode",
      result: { status: 0, stdout: Buffer.alloc(3), stderr: Buffer.alloc(0) },
      error: "transcript: FFmpeg returned an unaligned PCM stream",
    },
  ])("returns a per-item error for $name", async ({ result, error }) => {
    setTranscriptRuntimeForTests({
      ffmpegPath: async () => "/runtime/ffmpeg",
      runFfmpeg: () => result,
      createTranscriber: async () => async () => ({ text: "unused" }),
    });
    await expect(
      transcript({ id: "broken", mediaType: "audio/ogg", bytes: "Yg==" })
    ).resolves.toStrictEqual({ id: "broken", error });
  });

  it("canonicalizes segmented decoder text and surfaces model failures", async () => {
    let fail = false;
    setTranscriptRuntimeForTests({
      ffmpegPath: async () => "/runtime/ffmpeg",
      runFfmpeg: () => ({ status: 0, stdout: pcm(0), stderr: Buffer.alloc(0) }),
      createTranscriber: async () => async () => {
        if (fail) throw new Error("Whisper failed");
        return [{ text: " first " }, {}, { text: "second" }];
      },
    });
    await expect(
      transcript({ id: "segments", mediaType: "audio/flac", bytes: "cw==" })
    ).resolves.toStrictEqual({ id: "segments", text: "first second" });
    fail = true;
    await expect(
      transcript({ id: "failure", mediaType: "audio/flac", bytes: "Zg==" })
    ).resolves.toStrictEqual({ id: "failure", error: "Whisper failed" });
  });
});
