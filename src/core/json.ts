/**
 * Deep copy by JSON round trip: the result is exactly `JSON.parse(JSON.stringify(value))`.
 * Plain JSON data is copied unchanged; undefined members and functions are dropped, Dates become strings,
 * and an undefined top-level value, BigInt or a cycle throws, as JSON.stringify/JSON.parse do.
 */
export function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value));
}
