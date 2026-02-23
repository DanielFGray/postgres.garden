/**
 * HTTP client for playground API using Effect HttpApiClient
 */

import { Effect } from "effect";
import {
  httpApiCreatePlayground,
  httpApiDeletePlayground,
  httpApiForkPlayground,
  httpApiGetPlayground,
  httpApiListPlaygrounds,
  httpApiTogglePlaygroundStar,
  httpApiUpdatePlayground,
} from "../../../httpapi-client";
import type {
  Playground,
  PlaygroundListItem,
  CreatePlaygroundRequest,
  UpdatePlaygroundRequest,
} from "../types";

export class PlaygroundService {
  listPlaygrounds(options?: {
    sort?: string;
    offset?: number;
    limit?: number;
  }) {
    return httpApiListPlaygrounds({
      sort: options?.sort as "created_at" | "stars" | undefined,
      offset: options?.offset,
      limit: options?.limit,
    }).pipe(Effect.map((data) => data as unknown as PlaygroundListItem[]));
  }

  getPlayground(hash: string) {
    return httpApiGetPlayground(hash).pipe(Effect.map((data) => data as unknown as Playground));
  }

  createPlayground(request: CreatePlaygroundRequest) {
    return httpApiCreatePlayground({
      name: request.name ?? null,
      description: request.description ?? null,
      message: "Initial commit",
      files: [] as Array<{ path: string; content: string }>,
      activeFile: undefined,
    }).pipe(Effect.map((data) => data as unknown as Playground));
  }

  updatePlayground(hash: string, data: UpdatePlaygroundRequest) {
    return httpApiUpdatePlayground(hash, {
      name: data.name ?? null,
      description: data.description ?? null,
      privacy: data.privacy,
    }).pipe(Effect.map((result) => result as unknown as Playground));
  }

  deletePlayground(hash: string) {
    return httpApiDeletePlayground(hash).pipe(Effect.asVoid);
  }

  toggleStar(hash: string) {
    return httpApiTogglePlaygroundStar(hash).pipe(
      Effect.map((data) => {
        const payload = data as { starred?: boolean };
        return payload.starred === true;
      }),
    );
  }

  forkPlayground(hash: string, name?: string) {
    return httpApiForkPlayground(hash, { name: name ?? null }).pipe(
      Effect.map((data) => data as unknown as Playground),
    );
  }
}
