// Standalone launcher must not import update.ts (which imports daemon restart code).
const stable = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
export function stableManagedVersion(value: unknown): value is string {
	return typeof value === "string" && stable.exec(value)?.[0] === value;
}
export function newerManagedVersion(current: string, latest: string): boolean {
	if (!stableManagedVersion(current) || !stableManagedVersion(latest)) return false;
	const a = stable.exec(current)!; const b = stable.exec(latest)!;
	for (let i = 1; i <= 3; i++) {
		if (a[i] !== b[i]) return b[i]!.length !== a[i]!.length ? b[i]!.length > a[i]!.length : b[i]! > a[i]!;
	}
	return false;
}
