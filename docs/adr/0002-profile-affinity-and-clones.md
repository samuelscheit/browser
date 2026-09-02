# ADR 0002: profile affinity and disposable clones

Durable profiles remain on worker-local named volumes. A writer or interactive lease is exclusive. Read-only callers receive a disposable clone whose changes are discarded. Relocation is explicit: drain, archive, checksum-verify, restore to a declared target generation, then atomically update affinity and audit the generation change. Fabric never silently copies a profile after worker failure.
