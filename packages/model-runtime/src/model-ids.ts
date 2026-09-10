import type { ModelId } from "./types.js";

/**
 * The model ids the SYSTEM recognition handlers declare (#1011).
 *
 * ONE declaration each, in a module with no imports beyond a type. The
 * capability modules re-export from here, so a handler and the gateway's
 * boot-time provisioning read the same constant rather than two lists that
 * can drift; the gateway maps an id to its pinned files through
 * `models.lock.json` (`capabilities`), so there is no second capability list
 * anywhere either.
 *
 * This module is deliberately dependency-free: `capabilities/faces.ts` and
 * `capabilities/ocr.ts` pull in the ONNX and sharp resolution seams, and the
 * host must be able to learn which model a system automation wants without
 * loading any of that.
 *
 * A change here IS a model bump: `enrich_derivation.model` carries the id,
 * and every handler treats a stamp whose model differs from its current id as
 * absent, so a swap re-derives behind the recipe's own bounded cursor.
 */
export const FACES_MODEL_ID: ModelId = "yunet-arcface@1";
export const OCR_MODEL_ID: ModelId = "pp-ocrv5@1";
