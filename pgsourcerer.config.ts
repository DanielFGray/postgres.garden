import { defineConfig, effect, kysely } from "@danielfgray/pg-sourcerer";

export default defineConfig({
    connectionString: process.env.DATABASE_URL!,
    schemas: ["app_public", "app_private"],
    outputDir: "./generated",
    plugins: [
        // kysely({ generateQueries: false }),
        effect({
            repos: false,
            http: false,
        }),
    ],
});
