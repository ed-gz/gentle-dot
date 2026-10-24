import { SecureStorage } from "@aparajita/capacitor-secure-storage";
import { Capacitor } from "@capacitor/core";
import { type Connection, validConnection } from "./pairing.ts";

const KEY = "gentledot.mobile.connection.v1";
let memory: Connection | undefined;
export async function loadConnection(): Promise<Connection | undefined> {
	const value = Capacitor.isNativePlatform() ? await SecureStorage.get(KEY) : memory;
	return validConnection(value) ? value : undefined;
}
export async function saveConnection(connection: Connection): Promise<void> {
	if (!validConnection(connection)) throw new Error("Conexión no válida.");
	if (Capacitor.isNativePlatform()) await SecureStorage.set(KEY, { ...connection });
	else memory = connection;
}
export async function clearConnection(): Promise<void> {
	memory = undefined;
	if (Capacitor.isNativePlatform()) await SecureStorage.remove(KEY);
}
