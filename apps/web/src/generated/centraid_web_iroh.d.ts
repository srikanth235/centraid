/* tslint:disable */
/* eslint-disable -- governance: allow-no-unjustified-suppressions wasm-bindgen generated declaration */
/**
 * The `ReadableStreamType` enum.
 *
 * *This API requires the following crate features to be activated: `ReadableStreamType`*
 */

type ReadableStreamType = "bytes";

export class BrowserEndpoint {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    close(): Promise<void>;
    endpoint_id(): string;
    pair_gateway(endpoint_ticket: string, request_json: string): Promise<string>;
    request(endpoint_ticket: string, method: string, target: string, headers_json: string, body: Uint8Array): Promise<BrowserResponse>;
    secret_key(): Uint8Array;
    static spawn(secret_key?: Uint8Array | null): Promise<BrowserEndpoint>;
}

export class BrowserResponse {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    take_body(): ReadableStream;
    readonly headers_json: string;
    readonly status: number;
}

export class IntoUnderlyingByteSource {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    cancel(): void;
    pull(controller: ReadableByteStreamController): Promise<any>;
    start(controller: ReadableByteStreamController): void;
    readonly autoAllocateChunkSize: number;
    readonly type: ReadableStreamType;
}

export class IntoUnderlyingSink {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    abort(reason: any): Promise<any>;
    close(): Promise<any>;
    write(chunk: any): Promise<any>;
}

export class IntoUnderlyingSource {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    cancel(): void;
    pull(controller: ReadableStreamDefaultController): Promise<any>;
}

export function start(): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_browserendpoint_free: (a: number, b: number) => void;
    readonly __wbg_browserresponse_free: (a: number, b: number) => void;
    readonly browserendpoint_close: (a: number) => number;
    readonly browserendpoint_endpoint_id: (a: number, b: number) => void;
    readonly browserendpoint_pair_gateway: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly browserendpoint_request: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => number;
    readonly browserendpoint_secret_key: (a: number, b: number) => void;
    readonly browserendpoint_spawn: (a: number, b: number) => number;
    readonly browserresponse_headers_json: (a: number, b: number) => void;
    readonly browserresponse_status: (a: number) => number;
    readonly browserresponse_take_body: (a: number, b: number) => void;
    readonly start: () => void;
    readonly ring_core_0_17_14__bn_mul_mont: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly __wbg_intounderlyingbytesource_free: (a: number, b: number) => void;
    readonly __wbg_intounderlyingsink_free: (a: number, b: number) => void;
    readonly __wbg_intounderlyingsource_free: (a: number, b: number) => void;
    readonly intounderlyingbytesource_autoAllocateChunkSize: (a: number) => number;
    readonly intounderlyingbytesource_cancel: (a: number) => void;
    readonly intounderlyingbytesource_pull: (a: number, b: number) => number;
    readonly intounderlyingbytesource_start: (a: number, b: number) => void;
    readonly intounderlyingbytesource_type: (a: number) => number;
    readonly intounderlyingsink_abort: (a: number, b: number) => number;
    readonly intounderlyingsink_close: (a: number) => number;
    readonly intounderlyingsink_write: (a: number, b: number) => number;
    readonly intounderlyingsource_cancel: (a: number) => void;
    readonly intounderlyingsource_pull: (a: number, b: number) => number;
    readonly __wasm_bindgen_func_elem_1978: (a: number, b: number) => void;
    readonly __wasm_bindgen_func_elem_6195: (a: number, b: number) => void;
    readonly __wasm_bindgen_func_elem_4977: (a: number, b: number) => void;
    readonly __wasm_bindgen_func_elem_4283: (a: number, b: number, c: number, d: number) => void;
    readonly __wasm_bindgen_func_elem_1979: (a: number, b: number, c: number) => void;
    readonly __wasm_bindgen_func_elem_4978: (a: number, b: number) => void;
    readonly __wasm_bindgen_func_elem_4995: (a: number, b: number) => void;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export3: (a: number) => void;
    readonly __wbindgen_export4: (a: number, b: number, c: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
