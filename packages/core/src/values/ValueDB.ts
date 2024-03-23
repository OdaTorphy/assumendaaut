import type { JsonlDB } from "@alcalzone/jsonl-db";
import { EventEmitter } from "events";
import type { CommandClasses } from "../capabilities/CommandClasses";
import { ZWaveError, ZWaveErrorCodes } from "../error/ZWaveError";
import type { ValueMetadata } from "../values/Metadata";

/** Uniquely identifies to which CC, endpoint and property a value belongs to */
export interface ValueID {
	commandClass: CommandClasses;
	endpoint?: number;
	property: string | number;
	propertyKey?: string | number;
}

export interface TranslatedValueID extends ValueID {
	commandClassName: string;
	propertyName?: string;
	propertyKeyName?: string;
}

export interface ValueUpdatedArgs extends ValueID {
	prevValue: unknown;
	newValue: unknown;
}

export interface ValueAddedArgs extends ValueID {
	newValue: unknown;
}

export interface ValueRemovedArgs extends ValueID {
	prevValue: unknown;
}

export interface ValueNotificationArgs extends ValueID {
	value: unknown;
}

export interface MetadataUpdatedArgs extends ValueID {
	metadata: ValueMetadata | undefined;
}

type ValueAddedCallback = (args: ValueAddedArgs) => void;
type ValueUpdatedCallback = (args: ValueUpdatedArgs) => void;
type ValueRemovedCallback = (args: ValueRemovedArgs) => void;
type ValueNotificationCallback = (args: ValueNotificationArgs) => void;
type MetadataUpdatedCallback = (args: MetadataUpdatedArgs) => void;

interface ValueDBEventCallbacks {
	"value added": ValueAddedCallback;
	"value updated": ValueUpdatedCallback;
	"value removed": ValueRemovedCallback;
	"value notification": ValueNotificationCallback;
	"metadata updated": MetadataUpdatedCallback;
}

type ValueDBEvents = Extract<keyof ValueDBEventCallbacks, string>;

export function isValueID(param: Record<any, any>): param is ValueID {
	// commandClass is mandatory and must be numeric
	if (typeof param.commandClass !== "number") return false;
	// property is mandatory and must be a number or string
	if (
		typeof param.property !== "number" &&
		typeof param.property !== "string"
	) {
		return false;
	}
	// propertyKey is optional and must be a number or string
	if (
		param.propertyKey != undefined &&
		typeof param.propertyKey !== "number" &&
		typeof param.propertyKey !== "string"
	) {
		return false;
	}
	// endpoint is optional and must be a number
	if (param.endpoint != undefined && typeof param.endpoint !== "number") {
		return false;
	}
	return true;
}

export function assertValueID(
	param: Record<any, any>,
): asserts param is ValueID {
	if (!isValueID(param)) {
		throw new ZWaveError(
			`Invalid ValueID passed!`,
			ZWaveErrorCodes.Argument_Invalid,
		);
	}
}

export interface ValueDB {
	on<TEvent extends ValueDBEvents>(
		event: TEvent,
		callback: ValueDBEventCallbacks[TEvent],
	): this;
	once<TEvent extends ValueDBEvents>(
		event: TEvent,
		callback: ValueDBEventCallbacks[TEvent],
	): this;
	removeListener<TEvent extends ValueDBEvents>(
		event: TEvent,
		callback: ValueDBEventCallbacks[TEvent],
	): this;
	removeAllListeners(event?: ValueDBEvents): this;

	emit<TEvent extends ValueDBEvents>(
		event: TEvent,
		...args: Parameters<ValueDBEventCallbacks[TEvent]>
	): boolean;
}

/**
 * Ensures all Value ID properties are in the same order and there are no extraneous properties.
 * A normalized value ID can be used as a database key */
export function normalizeValueID(valueID: ValueID): ValueID {
	// valueIdToString is used by all other methods of the Value DB.
	// Since those may be called by unsanitized value IDs, we need
	// to make sure we have a valid value ID at our hands
	assertValueID(valueID);
	const { commandClass, endpoint, property, propertyKey } = valueID;

	const jsonKey: ValueID = {
		commandClass,
		endpoint: endpoint ?? 0,
		property,
	};
	if (propertyKey != undefined) jsonKey.propertyKey = propertyKey;
	return jsonKey;
}

export function valueIdToString(valueID: ValueID): string {
	return JSON.stringify(normalizeValueID(valueID));
}

export interface SetValueOptions {
	/** When this is true, no event will be emitted for the value change */
	noEvent?: boolean;
	/** When this is true,  */
	noThrow?: boolean;
	/**
	 * When this is `false`, the value will not be stored and a `value notification` event will be emitted instead (implies `noEvent: false`).
	 */
	stateful?: boolean;
}

/**
 * The value store for a single node
 */
export class ValueDB extends EventEmitter {
	// This is a wrapper around the driver's on-disk value and metadata key value stores
	public constructor(
		nodeId: number,
		valueDB: JsonlDB,
		metadataDB: JsonlDB<ValueMetadata>,
	) {
		super();
		this.nodeId = nodeId;
		this._db = valueDB;
		this._metadata = metadataDB;
	}

	private nodeId: number;
	private _db: JsonlDB<unknown>;
	private _metadata: JsonlDB<ValueMetadata>;

	private valueIdToDBKey(valueID: ValueID): string {
		return JSON.stringify({
			nodeId: this.nodeId,
			...normalizeValueID(valueID),
		});
	}

	private dbKeyToValueId(key: string): { nodeId: number } & ValueID {
		try {
			// Try the dumb but fast way first
			return dbKeyToValueIdFast(key);
		} catch {
			// Fall back to JSON.parse if anything went wrong
			return JSON.parse(key);
		}
	}

	/**
	 * Stores a value for a given value id
	 */
	public setValue(
		valueId: ValueID,
		value: unknown,
		options: SetValueOptions = {},
	): void {
		let dbKey: string;
		try {
			dbKey = this.valueIdToDBKey(valueId);
		} catch (e) {
			if (
				e instanceof ZWaveError &&
				e.code === ZWaveErrorCodes.Argument_Invalid &&
				options.noThrow === true
			) {
				// ignore invalid value IDs
				return;
			}
			throw e;
		}

		if (options.stateful !== false) {
			const cbArg: ValueAddedArgs | ValueUpdatedArgs = {
				...valueId,
				newValue: value,
			};
			let event: ValueDBEvents;
			if (this._db.has(dbKey)) {
				event = "value updated";
				(cbArg as ValueUpdatedArgs).prevValue = this._db.get(dbKey);
			} else {
				event = "value added";
			}

			this._db.set(dbKey, value);
			if (options.noEvent !== true) {
				this.emit(event, cbArg);
			}
		} else {
			// For non-stateful values just emit a notification
			this.emit("value notification", {
				...valueId,
				value,
			});
		}
	}

	/**
	 * Removes a value for a given value id
	 */
	public removeValue(
		valueId: ValueID,
		options: SetValueOptions = {},
	): boolean {
		const dbKey: string = this.valueIdToDBKey(valueId);
		if (this._db.has(dbKey)) {
			const prevValue = this._db.get(dbKey);
			this._db.delete(dbKey);
			const cbArg: ValueRemovedArgs = {
				...valueId,
				prevValue,
			};
			if (options.noEvent !== true) {
				this.emit("value removed", cbArg);
			}
			return true;
		}
		return false;
	}

	/**
	 * Retrieves a value for a given value id
	 */
	/* wotan-disable-next-line no-misused-generics */
	public getValue<T = unknown>(valueId: ValueID): T | undefined {
		const key = this.valueIdToDBKey(valueId);
		return this._db.get(key) as T | undefined;
	}

	/**
	 * Checks if a value for a given value id exists in this ValueDB
	 */
	public hasValue(valueId: ValueID): boolean {
		const key = this.valueIdToDBKey(valueId);
		return this._db.has(key);
	}

	/** Returns all values whose id matches the given predicate */
	public findValues(
		predicate: (id: ValueID) => boolean,
	): (ValueID & { value: unknown })[] {
		const ret: ReturnType<ValueDB["findValues"]> = [];
		for (const key of this._db.keys()) {
			const { nodeId, ...valueId } = this.dbKeyToValueId(key);
			if (nodeId !== this.nodeId) continue;

			if (predicate(valueId)) {
				ret.push({ ...valueId, value: this._db.get(key) });
			}
		}
		return ret;
	}

	/** Returns all values that are stored for a given CC */
	public getValues(forCC: CommandClasses): (ValueID & { value: unknown })[] {
		const ret: ReturnType<ValueDB["getValues"]> = [];
		this._db.forEach((value, key) => {
			const { nodeId, ...valueId } = this.dbKeyToValueId(key);
			if (nodeId !== this.nodeId) return;

			if (forCC === valueId.commandClass) ret.push({ ...valueId, value });
		});
		return ret;
	}

	/** Clears all values from the value DB */
	public clear(options: SetValueOptions = {}): void {
		const oldValues = [...this._db].filter(([key]) => {
			const { nodeId } = this.dbKeyToValueId(key);
			return nodeId === this.nodeId;
		});
		const oldMetadataKeys = [...this._metadata.keys()].filter((key) => {
			const { nodeId } = this.dbKeyToValueId(key);
			return nodeId === this.nodeId;
		});

		oldValues.forEach(([key, prevValue]) => {
			const { nodeId, ...valueId } = this.dbKeyToValueId(key);
			this._db.delete(key);
			if (options.noEvent !== true) {
				const cbArg: ValueRemovedArgs = {
					...valueId,
					prevValue,
				};
				this.emit("value removed", cbArg);
			}
		});
		oldMetadataKeys.forEach((key) => {
			const { nodeId, ...valueId } = this.dbKeyToValueId(key);
			this._metadata.delete(key);

			if (options.noEvent !== true) {
				const cbArg: MetadataUpdatedArgs = {
					...valueId,
					metadata: undefined,
				};
				this.emit("metadata updated", cbArg);
			}
		});
	}

	/**
	 * Stores metadata for a given value id
	 */
	public setMetadata(
		valueId: ValueID,
		metadata: ValueMetadata | undefined,
		options: SetValueOptions = {},
	): void {
		let dbKey: string;
		try {
			dbKey = this.valueIdToDBKey(valueId);
		} catch (e) {
			if (
				e instanceof ZWaveError &&
				e.code === ZWaveErrorCodes.Argument_Invalid &&
				options.noThrow === true
			) {
				// ignore invalid value IDs
				return;
			}
			throw e;
		}

		if (metadata) {
			this._metadata.set(dbKey, metadata);
		} else {
			this._metadata.delete(dbKey);
		}

		const cbArg: MetadataUpdatedArgs = {
			...valueId,
			metadata,
		};
		if (options.noEvent !== true) {
			this.emit("metadata updated", cbArg);
		}
	}

	/**
	 * Checks if metadata for a given value id exists in this ValueDB
	 */
	public hasMetadata(valueId: ValueID): boolean {
		const key = this.valueIdToDBKey(valueId);
		return this._metadata.has(key);
	}

	/**
	 * Retrieves metadata for a given value id
	 */
	public getMetadata(valueId: ValueID): ValueMetadata | undefined {
		const key = this.valueIdToDBKey(valueId);
		return this._metadata.get(key);
	}

	/** Returns all metadata that is stored for a given CC */
	public getAllMetadata(
		forCC: CommandClasses,
	): (ValueID & {
		metadata: ValueMetadata;
	})[] {
		const ret: ReturnType<ValueDB["getAllMetadata"]> = [];
		this._metadata.forEach((meta, key) => {
			const { nodeId, ...valueId } = this.dbKeyToValueId(key);
			if (nodeId !== this.nodeId) return;

			if (forCC === valueId.commandClass)
				ret.push({ ...valueId, metadata: meta });
		});
		return ret;
	}

	/** Returns all values whose id matches the given predicate */
	public findMetadata(
		predicate: (id: ValueID) => boolean,
	): (ValueID & {
		metadata: ValueMetadata;
	})[] {
		const ret: ReturnType<ValueDB["findMetadata"]> = [];
		for (const key of this._metadata.keys()) {
			const { nodeId, ...valueId } = this.dbKeyToValueId(key);
			if (nodeId !== this.nodeId) continue;

			if (predicate(valueId)) {
				ret.push({ ...valueId, metadata: this._metadata.get(key)! });
			}
		}
		return ret;
	}
}

/**
 * Really dumb but very fast way to parse one-lined JSON strings of the following schema
 * {
 *     nodeId: number,
 *     commandClass: number,
 *     endpoint: number,
 *     property: string | number,
 *     propertyKey: string | number,
 * }
 *
 * In benchmarks this was about 58% faster than JSON.parse
 */
export function dbKeyToValueIdFast(key: string): { nodeId: number } & ValueID {
	let start = 10; // {"nodeId":
	if (key.charCodeAt(start - 1) !== 58) {
		console.error(key.slice(start - 1));
		throw new Error("Invalid input format!");
	}
	let end = start + 1;
	const len = key.length;

	while (end < len && key.charCodeAt(end) !== 44) end++;
	const nodeId = parseInt(key.slice(start, end));

	start = end + 16; // ,"commandClass":
	if (key.charCodeAt(start - 1) !== 58)
		throw new Error("Invalid input format!");
	end = start + 1;
	while (end < len && key.charCodeAt(end) !== 44) end++;
	const commandClass = parseInt(key.slice(start, end));

	start = end + 12; // ,"endpoint":
	if (key.charCodeAt(start - 1) !== 58)
		throw new Error("Invalid input format!");
	end = start + 1;
	while (end < len && key.charCodeAt(end) !== 44) end++;
	const endpoint = parseInt(key.slice(start, end));

	start = end + 12; // ,"property":
	if (key.charCodeAt(start - 1) !== 58)
		throw new Error("Invalid input format!");

	let property;
	if (key.charCodeAt(start) === 34) {
		start++; // skip leading "
		end = start + 1;
		while (end < len && key.charCodeAt(end) !== 34) end++;
		property = key.slice(start, end);
		end++; // skip trailing "
	} else {
		end = start + 1;
		while (
			end < len &&
			key.charCodeAt(end) !== 44 &&
			key.charCodeAt(end) !== 125
		)
			end++;
		property = parseInt(key.slice(start, end));
	}

	if (key.charCodeAt(end) !== 125) {
		let propertyKey;
		start = end + 15; // ,"propertyKey":
		if (key.charCodeAt(start - 1) !== 58)
			throw new Error("Invalid input format!");
		if (key.charCodeAt(start) === 34) {
			start++; // skip leading "
			end = start + 1;
			while (end < len && key.charCodeAt(end) !== 34) end++;
			propertyKey = key.slice(start, end);
			end++; // skip trailing "
		} else {
			end = start + 1;
			while (
				end < len &&
				key.charCodeAt(end) !== 44 &&
				key.charCodeAt(end) !== 125
			)
				end++;
			propertyKey = parseInt(key.slice(start, end));
		}
		return {
			nodeId,
			commandClass,
			endpoint,
			property,
			propertyKey,
		};
	} else {
		return {
			nodeId,
			commandClass,
			endpoint,
			property,
		};
	}
}
