/**
 * Matchlock RPC / controller types — US-002.
 *
 * The types here mirror the REAL JSON-RPC wire contract implemented by
 * `matchlock rpc` (see the runtime source: pkg/rpc/handler.go). The pi
 * backend speaks this protocol line-by-line over the CLI's stdin/stdout —
 * one JSON-RPC request object per line in, one response or notification
 * per line out. No SDK dependency, no resident daemon.
 *
 * These shapes are derived from the actual tested requests (the runtime
 * contract corrects the earlier dependency-contract's underscore method
 * spellings: `exec_pipe.stdin` / `exec_pipe.stdin_eof`, NOT `exec_pipe_stdin`).
 */

/** OCI image identity returned by `resolve_image` and pinned onto `create`. */
export interface MatchlockImageIdentity {
  tag: string;
  /** OCI content/manifest digest, e.g. sha256:… */
  digest: string;
  /** Deterministic fingerprint of the relevant OCI config. */
  config_digest: string;
  /** Store scope/import source (local/registry/import/tag). */
  source: string;
  size: number;
  oci: {
    user?: string;
    working_dir?: string;
    entrypoint?: string[];
    cmd?: string[];
    env?: Record<string, string>;
  };
}

/** JSON-RPC error object as sent by the runtime. */
export interface MatchlockRpcErrorBody {
  code: number;
  message: string;
}

/** A live exec request identity (the request id) used for streams/cancel. */
export type MatchlockRequestId = number;

/**
 * Per-request stream frame routed by the RPC client.
 *
 * The runtime encodes EVERY stdout/stderr chunk as base64 in its own
 * notification (`params.data`); the frame below preserves that raw base64
 * verbatim so a chunk boundary can never corrupt a multi-byte UTF-8 sequence
 * or lose binary bytes. Frames are therefore NOT pre-decoded here: decode
 * exactly once at the consumption boundary (per frame for byte capture, or
 * after concatenating a stream's frames for text) with the helpers exported
 * from rpc-client.js (`decodeFrameBytes` / `decodeFramesText`). A consumer
 * that decodes a frame and then decodes the result again would double-decode
 * and is a bug by construction.
 */
export interface MatchlockStreamFrame {
  /** stdout | stderr (base64 payload) | ready (exec_pipe.stdin may be sent). */
  kind: "stdout" | "stderr" | "ready";
  /** Raw base64 wire payload for stdout/stderr frames (never re-encoded). */
  base64?: string;
  /** The exec request id this frame belongs to (notification params.id). */
  requestId?: number;
}

/** Final result of a streamed exec (exec_stream / exec_pipe). */
export interface MatchlockExecResult {
  exit_code: number;
  duration_ms: number;
}

/** A completed exec (exec) with base64-encoded captured output. */
export interface MatchlockExecBufferedResult extends MatchlockExecResult {
  stdout: string;
  stderr: string;
}

/** Exec command options accepted by exec/exec_stream/exec_pipe. */
export interface MatchlockExecOptions {
  command: string;
  working_dir?: string;
  user?: string;
}

// ── api.Config subset (create params) ───────────────────────────────

export interface MatchlockResourcesConfig {
  cpus?: number;
  memory_mb?: number;
  disk_size_mb?: number;
}

export interface MatchlockNetworkConfig {
  block_private_ips?: boolean;
  intercept?: boolean;
  no_network?: boolean;
  hostname?: string;
  /**
   * MTLK-ALLOW-PRIVATE: per-run exception list of private destinations
   * (host names, IP literals or CIDRs, optional `:port`). Mirrors the
   * matchlock fork's `network.allow_private`; omitted when no entries were
   * admitted.
   */
  allow_private?: string[];
}

export interface MatchlockMountConfig {
  type: "host_fs" | "memory" | "overlay";
  host_path?: string;
  readonly?: boolean;
  upper?: MatchlockMountConfig;
  lower?: MatchlockMountConfig;
  owner_uid?: number;
  owner_gid?: number;
}

export interface MatchlockVfsConfig {
  workspace?: string;
  exact_destinations?: boolean;
  mounts?: Record<string, MatchlockMountConfig>;
}

/**
 * The `create` RPC params: the api.Config machine shape plus the pinned
 * `image_identity` the image-admission handler verifies BEFORE building the
 * VM. `image_identity` is NOT part of the runtime api.Config struct — it is
 * a separate admitted field (see image-contract.json create_verification).
 */
export interface MatchlockCreateParams {
  image: string;
  image_identity?: { digest: string; config_digest: string; tag?: string };
  resources?: MatchlockResourcesConfig;
  network?: MatchlockNetworkConfig;
  env?: Record<string, string>;
  vfs?: MatchlockVfsConfig;
}

/** Result of a successful `create`: the server-assigned VM id. */
export interface MatchlockCreateResult {
  id: string;
}
