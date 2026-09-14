import { expect, test } from "bun:test";
import { FabricError } from "@browser-fabric/contracts";
import { S3HttpClient, S3ObjectStore, type S3LikeClient } from "@browser-fabric/control-plane";

type StoredObject = {
  body: Uint8Array;
  contentType: string;
  metadata: Record<string, string>;
};

class FakeS3Client implements S3LikeClient {
  readonly objects = new Map<string, StoredObject>();
  putCalls = 0;

  public async putObject(input: { bucket: string; key: string; body: Uint8Array; contentType: string; metadata: Record<string, string>; ifNoneMatch?: "*" }): Promise<{ etag?: string }> {
    if (input.ifNoneMatch === "*" && this.objects.has(`${input.bucket}:${input.key}`)) {
      throw new FabricError("conflict", "object exists", 409);
    }
    this.putCalls += 1;
    this.objects.set(`${input.bucket}:${input.key}`, {
      body: new Uint8Array(input.body),
      contentType: input.contentType,
      metadata: { ...input.metadata },
    });
    return { etag: "unit-test-etag" };
  }

  public async headObject(input: { bucket: string; key: string }) {
    const object = this.objects.get(`${input.bucket}:${input.key}`);
    if (!object) throw new FabricError("not_found", "object absent", 404);
    return { contentType: object.contentType, contentLength: object.body.byteLength, metadata: { ...object.metadata } };
  }

  public async getObject(input: { bucket: string; key: string }) {
    const object = this.objects.get(`${input.bucket}:${input.key}`);
    if (!object) throw new FabricError("not_found", "object absent", 404);
    return { body: new Uint8Array(object.body), contentType: object.contentType, metadata: { ...object.metadata } };
  }

  public async deleteObject(input: { bucket: string; key: string }): Promise<void> {
    this.objects.delete(`${input.bucket}:${input.key}`);
  }

  public async presignGet(input: { bucket: string; key: string; expiresIn: number }): Promise<string> {
    return `https://object-store.invalid/${input.bucket}/${input.key}?expires=${input.expiresIn}`;
  }
}

test("S3 object storage replays only the exact immutable object and verifies bytes on read", async () => {
  const client = new FakeS3Client();
  const store = new S3ObjectStore(client, "fabric-artifacts", () => new Date("2026-09-04T00:00:00.000Z"));
  const input = {
    key: "projects/project_test/artifacts/job_test/screenshot/fixture",
    body: new TextEncoder().encode("immutable artifact"),
    contentType: "image/png",
    expiresAt: "2026-10-04T00:00:00.000Z",
    metadata: { project: "project_test", kind: "screenshot" },
  };

  const created = await store.put(input);
  const replay = await store.put({ ...input, body: new Uint8Array(input.body) });
  expect(replay).toEqual(created);
  expect(client.putCalls).toBe(1);

  await expect(store.put({ ...input, expiresAt: "2026-10-05T00:00:00.000Z" })).rejects.toMatchObject({ code: "conflict" });
  await expect(store.put({ ...input, body: new TextEncoder().encode("different") })).rejects.toMatchObject({ code: "conflict" });

  const stored = client.objects.get(`fabric-artifacts:${input.key}`)!;
  stored.body[0] = 0;
  await expect(store.get(input.key)).rejects.toMatchObject({ code: "internal_error" });
});

test("S3 HTTP client signs endpoint-scoped requests and presigned reads without exposing the secret", async () => {
  const calls: Array<{ url: string; headers: Headers }> = [];
  const client = new S3HttpClient({
    endpoint: "https://minio.example.test",
    accessKey: "unit-test-access-key",
    secretKey: "unit-test-secret-material",
    bucket: "fabric-artifacts",
    clock: () => new Date("2026-09-04T00:00:00.000Z"),
    fetch: async (url, init) => {
      calls.push({ url: String(url), headers: new Headers(init?.headers) });
      return new Response(null, { status: 200, headers: { etag: "unit-test-etag", "content-length": "0" } });
    },
  });

  await client.putObject({
    bucket: "fabric-artifacts",
    key: "projects/project_test/artifacts/job_test/log/fixture",
    body: new TextEncoder().encode("x"),
    contentType: "text/plain",
    metadata: { project: "project_test", kind: "log" },
  });
  const request = calls[0]!;
  expect(request.url).toBe("https://minio.example.test/fabric-artifacts/projects/project_test/artifacts/job_test/log/fixture");
  expect(request.headers.get("authorization")).toContain("Credential=unit-test-access-key/20260904/us-east-1/s3/aws4_request");
  expect(request.headers.get("authorization")).not.toContain("unit-test-secret-material");
  expect(request.headers.get("x-amz-meta-project")).toBe("project_test");

  const signed = await client.presignGet({ bucket: "fabric-artifacts", key: "projects/project_test/artifacts/job_test/log/fixture", expiresIn: 60 });
  expect(signed).toContain("X-Amz-Algorithm=AWS4-HMAC-SHA256");
  expect(signed).toContain("X-Amz-Expires=60");
  expect(signed).not.toContain("unit-test-secret-material");
  await expect(client.putObject({ bucket: "another-bucket", key: "projects/project_test/a", body: new Uint8Array(), contentType: "text/plain", metadata: {} })).rejects.toMatchObject({ code: "authorization_denied" });
});
