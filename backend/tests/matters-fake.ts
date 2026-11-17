import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import type { Db, ObjectId } from "mongodb";
import type { Mock } from "vitest";
import { vi } from "vitest";
import { createApp } from "../src/app.js";
import { loadEnv } from "../src/config/env.js";
import type { MatterDocument } from "../src/models/matter.js";

export interface MattersFakeState {
  docs: MatterDocument[];
}

/** Minimal structural stand-in for the driver collection methods we use. */
export interface FakeCollection {
  createIndex: Mock;
  insertOne: Mock;
  findOne: Mock;
  find: Mock;
}

export interface MattersFake {
  db: Db;
  state: MattersFakeState;
  collection: FakeCollection;
}

type SortSpec = Record<string, 1 | -1>;

function sortDocs(docs: MatterDocument[], spec: SortSpec): MatterDocument[] {
  const entries = Object.entries(spec);
  return [...docs].sort((a, b) => {
    for (const [key, direction] of entries) {
      const left = key === "createdAt" ? a.createdAt.getTime() : a.updatedAt.getTime();
      const right = key === "createdAt" ? b.createdAt.getTime() : b.updatedAt.getTime();
      if (left !== right) {
        return direction === -1 ? right - left : left - right;
      }
    }
    return 0;
  });
}

export function createMattersFake(): MattersFake {
  const state: MattersFakeState = { docs: [] };
  const collection: FakeCollection = {
    createIndex: vi.fn(async () => "createdAt_-1"),
    insertOne: vi.fn(async (doc: MatterDocument) => {
      state.docs.push({ ...doc });
      return { acknowledged: true, insertedId: doc._id };
    }),
    findOne: vi.fn(async (filter: { _id?: ObjectId }) => {
      if (filter._id === undefined) {
        return null;
      }
      return state.docs.find((d) => d._id.equals(filter._id)) ?? null;
    }),
    find: vi.fn(() => ({
      sort: (spec: SortSpec) => ({
        toArray: async () => sortDocs(state.docs, spec),
      }),
    })),
  };
  const db = {
    collection: (_name: string) => collection,
  } as unknown as Db;
  return { db, state, collection };
}

export interface RunningApp {
  baseUrl: string;
  close: () => Promise<void>;
}

export async function startApp(mongodbUri: string | undefined): Promise<RunningApp> {
  const env = loadEnv({
    ...process.env,
    FRONTEND_ORIGIN: "http://localhost:3000",
    MONGODB_URI: mongodbUri,
  });
  const app: Express = createApp(env);
  const server: Server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
