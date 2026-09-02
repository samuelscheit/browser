"""Typed Browser Fabric client. Transport must be configured with mTLS externally."""
from .client import BrowserFabricClient, FabricError

__all__ = ["BrowserFabricClient", "FabricError"]
