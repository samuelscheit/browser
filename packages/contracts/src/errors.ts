export type ProblemCode =
  | "authentication_required"
  | "authorization_denied"
  | "not_found"
  | "conflict"
  | "validation_failed"
  | "idempotency_conflict"
  | "invalid_state"
  | "capacity_exhausted"
  | "capability_invalid"
  | "capability_expired"
  | "secret_rejected"
  | "worker_unavailable"
  | "deadline_exceeded"
  | "internal_error";

export class FabricError extends Error {
  public readonly code: ProblemCode;
  public readonly status: number;
  public readonly details?: Record<string, unknown>;

  public constructor(code: ProblemCode, message: string, status: number, details?: Record<string, unknown>) {
    super(message);
    this.name = "FabricError";
    this.code = code;
    this.status = status;
    this.details = details;
  }

  public toProblem(): ApiProblem {
    return {
      type: `https://browser-fabric.dev/problems/${this.code}`,
      title: this.code.replaceAll("_", " "),
      status: this.status,
      detail: this.message,
      code: this.code,
      ...(this.details === undefined ? {} : { details: this.details })
    };
  }
}

export interface ApiProblem {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: ProblemCode;
  details?: Record<string, unknown>;
}

export function fail(
  code: ProblemCode,
  message: string,
  status: number,
  details?: Record<string, unknown>
): never {
  throw new FabricError(code, message, status, details);
}
