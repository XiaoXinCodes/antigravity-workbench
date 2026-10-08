# Retained regression implementations

These modules are not reachable from the product entry points (`extension`, `bridge`). They retain CLI image, CLI quota and generic switch implementations as independent regression fixtures. The legacy image renderer is also used by synthetic layout fixtures, which are not screenshots of the current direct-image panel.

TypeScript still checks and compiles these modules under `out/legacy`; existing tests still run. Both VSIX and npm packaging exclude `out/legacy`. Product code must not import this directory; release verification checks every shipped literal local import against packaged files.

Shared image guards remain outside this directory because active diagnostics use their validation helpers. Existing snapshot commands remain registered for compatibility with saved data. Changes to these contracts or fixtures require independent regression review.
