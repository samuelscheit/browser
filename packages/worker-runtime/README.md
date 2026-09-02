# Worker runtime boundary

Every runtime receives a Fabric-produced `WorkerAssignment`, not arbitrary client launch arguments. `GenericBrowserRuntime` builds a constrained container spec with private networking, bounded resources, no Docker socket, no host-home/repository mounts, and no application-secret environment. Runtime-specific workers may add protocol behavior but must preserve those invariants.
