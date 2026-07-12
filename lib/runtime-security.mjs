export function enforcePrivateUmask({ processImpl = process } = {}) {
  processImpl.umask(0o077);
  return 0o077;
}

export const RUNTIME_SECURITY_FEATURES = Object.freeze({
  strictTelegramIdentity: true,
  lockdownEnforced: true,
  privateState: true,
});
