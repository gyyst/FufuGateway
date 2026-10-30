export const CONFIG_CURRENT_KEY = "config:current";
export const CONFIG_PREVIOUS_KEY = "config:previous";

export function configSnapshotKey(version: number): string {
  return `config:snapshot:${version}`;
}
