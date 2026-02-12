/**
 * HTTP client for playground API using Elysia Eden Fetch
 */

import { api } from "../../../api-client";
import type {
  Playground,
  PlaygroundListItem,
  CreatePlaygroundRequest,
  UpdatePlaygroundRequest,
} from "../types";

export class PlaygroundService {
  async listPlaygrounds(
    options?: { sort?: string; offset?: number; limit?: number },
  ): Promise<PlaygroundListItem[]> {
    const { data, error } = await api("/api/playgrounds", {
      method: "GET",
      query: {
        sort: (options?.sort ?? null) as "created_at" | "stars" | null | undefined,
        offset: options?.offset ?? null,
        limit: options?.limit ?? null,
      },
    });

    if (error) {
      throw new Error(
        `Failed to list playgrounds: ${error.status} ${JSON.stringify(error.value)}`,
      );
    }

    if (!data) {
      throw new Error("Failed to list playgrounds: no data returned");
    }

    // Server returns Date objects; client types expect strings
    return data as unknown as PlaygroundListItem[];
  }

  async getPlayground(hash: string): Promise<Playground> {
    const { data, error } = await api("/api/playgrounds/:hash", {
      method: "GET",
      params: { hash },
    });

    if (error) {
      throw new Error(
        `Failed to get playground: ${error.status} ${JSON.stringify(error.value)}`,
      );
    }

    if (!data) {
      throw new Error("Failed to get playground: no data returned");
    }

    return data as unknown as Playground;
  }

  async createPlayground(request: CreatePlaygroundRequest): Promise<Playground> {
    const { data: result, error } = await api("/api/playgrounds", {
      method: "POST",
      body: {
        name: request.name ?? null,
        description: request.description ?? null,
        message: "Initial commit",
        files: [] as { path: string; content: string }[],
        activeFile: undefined,
      },
    });

    if (error) {
      throw new Error(
        `Failed to create playground: ${error.status} ${JSON.stringify(error.value)}`,
      );
    }

    if (!result) {
      throw new Error("Failed to create playground: no data returned");
    }

    return result as unknown as Playground;
  }

  async updatePlayground(
    hash: string,
    data: UpdatePlaygroundRequest,
  ): Promise<Playground> {
    const { data: result, error } = await api("/api/playgrounds/:hash", {
      method: "PUT",
      params: { hash },
      body: {
        name: data.name ?? null,
        description: data.description ?? null,
        privacy: data.privacy ?? null,
      },
    });

    if (error) {
      throw new Error(
        `Failed to update playground: ${error.status} ${JSON.stringify(error.value)}`,
      );
    }

    if (!result) {
      throw new Error("Failed to update playground: no data returned");
    }

    return result as unknown as Playground;
  }

  async deletePlayground(hash: string): Promise<void> {
    const { error } = await api("/api/playgrounds/:hash", {
      method: "DELETE",
      params: { hash },
    });

    if (error) {
      throw new Error(
        `Failed to delete playground: ${error.status} ${JSON.stringify(error.value)}`,
      );
    }
  }

  async forkPlayground(hash: string, name?: string): Promise<Playground> {
    const { data, error } = await api("/api/playgrounds/:hash/fork", {
      method: "POST",
      params: { hash },
      body: { name },
    });

    if (error) {
      throw new Error(
        `Failed to fork playground: ${error.status} ${JSON.stringify(error.value)}`,
      );
    }

    if (!data) {
      throw new Error("Failed to fork playground: no data returned");
    }

    return data as unknown as Playground;
  }
}
