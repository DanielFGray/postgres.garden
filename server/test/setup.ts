import { testDatabaseEnv } from "./testDatabase.js";

Object.assign(process.env, testDatabaseEnv(process.env));
