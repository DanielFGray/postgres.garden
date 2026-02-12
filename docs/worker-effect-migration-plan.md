# Worker Effect Migration Plan

## Executive Summary

This document outlines the complete plan to migrate worker scripts from plain JavaScript to TypeScript with Effect-TS for improved type safety, error handling, and maintainability.

**Status:** Ready to implement
**Estimated Time:** 4-6 hours total
**Breaking Changes:** None (gradual migration)

## Current State

### Directory Structure
```
worker/
├── tasks/
│   ├── send_email.js (ESM, has @ts-check)
│   ├── sponsor_webhook.js (ESM)
│   ├── user__audit.js (ESM)
│   ├── user__forgot_password.js (ESM)
│   ├── user__forgot_password_unregistered_email.js (ESM)
│   ├── user__send_delete_account_email.js (ESM)
│   └── user_emails__send_verification.js (ESM)
├── templates/ (MJML email templates)
├── transport.js (nodemailer setup)
├── types.d.ts (empty GraphileWorker.Tasks interface)
└── crontab
```

### Dependencies
- `graphile-worker@0.16.6` - Job queue (native TypeScript support)
- `effect@^3.19.3` - Already installed, used in scripts/server
- `@effect/platform@^0.93.3` - Already installed
- `@effect/platform-node@^0.101.0` - Already installed
- Runtime: Bun (native TypeScript transpilation)

### Current Problems
1. No runtime payload validation (only JSDoc types)
2. Generic error handling (try/catch with no discrimination)
3. No retry logic for transient failures
4. Manual resource management
5. Hard to test (side effects everywhere)
6. Inconsistent logging (console.log)
7. No observability/tracing

## Graphile Worker TypeScript Support

### Native .ts Support
Graphile Worker v0.16.6 supports TypeScript files directly via the `LoadTaskFromJsPlugin`:

**Default file extensions:** `[".js", ".mjs", ".cjs"]`

**Configuration options:**
1. Via `.graphile-workerrc` file in worker directory
2. Via command-line flags: `--file-extensions .ts .js`
3. Via GraphileConfig preset in code

**How it works:**
- Uses `import(pathToFileURL(file).href)` for dynamic imports
- Bun transpiles `.ts` → JavaScript on the fly
- No build step needed in development
- Can pre-compile for production if desired

### File Discovery
Graphile worker discovers tasks by filename:
- `tasks/user__forgot_password.ts` → task name: `user__forgot_password`
- Must export default a function matching `Task` type
- Looks for files in priority order of extensions

## Migration Strategy

### Phase 1: Foundation (1-2 hours)

#### 1.1 Create Graphile Worker Config
**File:** `worker/.graphile-workerrc`
```json
{
  "worker": {
    "fileExtensions": [".ts", ".js"],
    "taskDirectory": "tasks"
  }
}
```

**Alternative:** Update package.json script
```json
{
  "scripts": {
    "worker": "cd worker && bun --env-file=../.env graphile-worker --file-extensions .ts .js"
  }
}
```

#### 1.2 Create Worker TypeScript Config
**File:** `worker/tsconfig.json`
```json
{
  "extends": "../tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": ".",
    "allowJs": true,
    "checkJs": true,
    "moduleResolution": "bundler",
    "module": "ESNext",
    "target": "ESNext",
    "strict": true,
    "noEmit": true
  },
  "include": ["**/*.ts", "**/*.js"],
  "exclude": ["node_modules", "dist", "templates"]
}
```

**Update root tsconfig.json:**
```json
{
  "include": [
    "src",
    "server",
    "worker"  // Add this line
  ]
}
```

#### 1.3 Create Effect Schemas
**File:** `worker/schemas.ts`
```typescript
import * as S from "effect/Schema";

// Email payload schema with runtime validation
export class SendEmailPayload extends S.Class<SendEmailPayload>("SendEmailPayload")({
  options: S.Struct({
    from: S.optional(S.String),
    to: S.Union(S.String, S.Array(S.String)),
    subject: S.String,
  }),
  template: S.String,
  variables: S.Record({ key: S.String, value: S.Unknown }),
}) {}

// User forgot password payload
export class UserForgotPasswordPayload extends S.Class<UserForgotPasswordPayload>("UserForgotPasswordPayload")({
  id: S.UUID,
  email: S.String.pipe(S.pattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)),
  token: S.String.pipe(S.minLength(32)),
}) {}

// User forgot password (unregistered)
export class UserForgotPasswordUnregisteredEmailPayload extends S.Class<UserForgotPasswordUnregisteredEmailPayload>("UserForgotPasswordUnregisteredEmailPayload")({
  email: S.String.pipe(S.pattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)),
}) {}

// Delete account email payload
export class UserSendAccountDeletionEmailPayload extends S.Class<UserSendAccountDeletionEmailPayload>("UserSendAccountDeletionEmailPayload")({
  email: S.String,
  token: S.String.pipe(S.minLength(32)),
}) {}

// Email verification payload
export class UserEmailsSendVerificationPayload extends S.Class<UserEmailsSendVerificationPayload>("UserEmailsSendVerificationPayload")({
  id: S.UUID,
}) {}

// User audit action types
export const AccountAction = S.Literal(
  "linked_account",
  "unlinked_account",
  "changed_password",
  "reset_password",
  "added_email",
  "removed_email"
);

// User audit payload (discriminated union)
export class UserAuditPayload extends S.Union(
  S.Struct({
    type: S.Literal("added_email"),
    user_id: S.UUID,
    current_user_id: S.UUID,
    extra1: S.String,
    extra2: S.String, // email address
  }),
  S.Struct({
    type: S.Literal("removed_email"),
    user_id: S.UUID,
    current_user_id: S.UUID,
    extra1: S.String,
    extra2: S.String, // email address
  }),
  S.Struct({
    type: S.Literal("linked_account"),
    user_id: S.UUID,
    current_user_id: S.UUID,
    extra1: S.String, // provider name
    extra2: S.String,
  }),
  S.Struct({
    type: S.Literal("unlinked_account"),
    user_id: S.UUID,
    current_user_id: S.UUID,
    extra1: S.String, // provider name
    extra2: S.String,
  }),
  S.Struct({
    type: S.Literal("reset_password"),
    user_id: S.UUID,
    current_user_id: S.UUID,
  }),
  S.Struct({
    type: S.Literal("change_password"),
    user_id: S.UUID,
    current_user_id: S.UUID,
  })
) {}

// Sponsor webhook payload
export class SponsorWebhookPayload extends S.Class<SponsorWebhookPayload>("SponsorWebhookPayload")({
  status: S.Union(S.Literal("active"), S.Literal("cancelled")),
  tier: S.optional(S.String),
}) {}
```

#### 1.4 Create Tagged Errors
**File:** `worker/errors.ts`
```typescript
import { Schema } from "effect";

// Email sending errors
export class EmailSendError extends Schema.TaggedError<EmailSendError>()("EmailSendError", {
  recipient: Schema.String,
  reason: Schema.String,
}) {}

export class EmailQueueError extends Schema.TaggedError<EmailQueueError>()("EmailQueueError", {
  reason: Schema.String,
}) {}

// Template errors
export class TemplateNotFoundError extends Schema.TaggedError<TemplateNotFoundError>()("TemplateNotFoundError", {
  templateName: Schema.String,
}) {}

export class TemplateRenderError extends Schema.TaggedError<TemplateRenderError>()("TemplateRenderError", {
  templateName: Schema.String,
  error: Schema.Defect,
}) {}

// Database errors
export class DatabaseQueryError extends Schema.TaggedError<DatabaseQueryError>()("DatabaseQueryError", {
  query: Schema.String,
  error: Schema.Defect,
}) {}

export class UserNotFoundError extends Schema.TaggedError<UserNotFoundError>()("UserNotFoundError", {
  userId: Schema.String,
}) {}

export class UserEmailNotFoundError extends Schema.TaggedError<UserEmailNotFoundError>()("UserEmailNotFoundError", {
  userEmailId: Schema.String,
}) {}

// Validation errors
export class PayloadValidationError extends Schema.TaggedError<PayloadValidationError>()("PayloadValidationError", {
  errors: Schema.String,
}) {}

// Rate limiting
export class RateLimitError extends Schema.TaggedError<RateLimitError>()("RateLimitError", {
  resource: Schema.String,
  retryAfter: Schema.Number,
}) {}
```

#### 1.5 Create Effect Runtime
**File:** `worker/runtime.ts`
```typescript
import { Effect, Runtime, Layer, ManagedRuntime, Fiber, Exit } from "effect";
import { NodeRuntime } from "@effect/platform-node";

// Future: Add EmailTransportLive and other services here
const WorkerLive = Layer.mergeAll(
  NodeRuntime.layer,
  // EmailTransportLive will go here
);

// Create managed runtime for worker tasks
export const WorkerRuntime = ManagedRuntime.make(WorkerLive);

/**
 * Run an Effect as a Promise for graphile-worker
 * Uses runFork for proper interruption handling
 * 
 * IMPORTANT: Use this instead of runPromise
 * - runFork returns a Fiber that can be interrupted
 * - Handles SIGTERM/SIGINT gracefully
 * - Ensures proper cleanup via finalizers
 */
export const runWorkerEffect = <A, E>(
  effect: Effect.Effect<A, E>
): Promise<A> => {
  const fiber = WorkerRuntime.runFork(effect);
  
  return Fiber.await(fiber).then((exit: Exit.Exit<A, E>) => {
    if (Exit.isFailure(exit)) {
      // Convert Effect failure to rejected Promise
      // Graphile worker will handle retry based on error
      const error = Exit.causeSquash(exit.cause);
      throw error;
    }
    return exit.value;
  });
};

/**
 * Cleanup the runtime on process exit
 * Call this in worker shutdown hooks if needed
 */
export const shutdownRuntime = (): Promise<void> => {
  return WorkerRuntime.dispose();
};
```

#### 1.6 Create Effect Task Wrapper
**File:** `worker/effectTask.ts`
```typescript
import { Effect } from "effect";
import type { Task } from "graphile-worker";
import { runWorkerEffect } from "./runtime.js";

/**
 * Wrap an Effect program as a graphile-worker Task
 * 
 * Graphile worker expects: (payload: unknown, helpers: any) => Promise<void>
 * This wrapper:
 * 1. Accepts an Effect program
 * 2. Runs it via runFork (for interruption support)
 * 3. Converts Exit to Promise (reject on failure)
 * 
 * @example
 * export default effectTask((payload, helpers) =>
 *   Effect.gen(function* () {
 *     const validated = yield* S.decodeUnknown(MySchema)(payload);
 *     // ... task logic
 *   })
 * );
 */
export const effectTask = <E, A>(
  program: (payload: unknown, helpers: any) => Effect.Effect<A, E>
): Task => {
  return async (payload, helpers) => {
    await runWorkerEffect(program(payload, helpers));
  };
};
```

#### 1.7 Update Type Declarations
**File:** `worker/types.d.ts`
```typescript
import type {
  SendEmailPayload,
  UserForgotPasswordPayload,
  UserForgotPasswordUnregisteredEmailPayload,
  UserSendAccountDeletionEmailPayload,
  UserEmailsSendVerificationPayload,
  UserAuditPayload,
  SponsorWebhookPayload,
} from "./schemas.js";

declare global {
  namespace GraphileWorker {
    interface Tasks {
      send_email: typeof SendEmailPayload.Type;
      user__forgot_password: typeof UserForgotPasswordPayload.Type;
      user__forgot_password_unregistered_email: typeof UserForgotPasswordUnregisteredEmailPayload.Type;
      user__send_delete_account_email: typeof UserSendAccountDeletionEmailPayload.Type;
      user_emails__send_verification: typeof UserEmailsSendVerificationPayload.Type;
      user__audit: typeof UserAuditPayload.Type;
      sponsor_webhook: typeof SponsorWebhookPayload.Type;
    }
  }

  // For test environment
  var TEST_EMAILS: any[];
}

export {};
```

### Phase 2: Proof of Concept (30-45 min)

Migrate `user__forgot_password.js` as the first test case.

#### 2.1 Create New TypeScript Task
**File:** `worker/tasks/user__forgot_password.ts`
```typescript
import { Effect, Schedule } from "effect";
import * as S from "effect/Schema";
import { effectTask } from "../effectTask.js";
import { UserForgotPasswordPayload } from "../schemas.js";
import {
  PayloadValidationError,
  DatabaseQueryError,
  UserNotFoundError,
  EmailQueueError,
} from "../errors.js";

/**
 * Send password reset email to user
 * 
 * Flow:
 * 1. Validate payload with Effect Schema
 * 2. Fetch user from database
 * 3. Queue email job with retry logic
 * 4. Log success
 * 
 * Error handling:
 * - PayloadValidationError: Log and fail (invalid request)
 * - UserNotFoundError: Log warning and succeed (user deleted)
 * - EmailQueueError: Log and fail (worker will retry)
 */
export default effectTask((rawPayload, { addJob, withPgClient }) =>
  Effect.gen(function* () {
    // 1. Validate payload with runtime check
    const payload = yield* S.decodeUnknown(UserForgotPasswordPayload)(rawPayload).pipe(
      Effect.mapError((error) =>
        new PayloadValidationError({
          errors: S.TreeFormatter.formatErrorSync(error),
        })
      )
    );

    // 2. Fetch user from database with error handling
    const { rows } = yield* Effect.tryPromise({
      try: () =>
        withPgClient((client) =>
          client.query(
            `select users.* from app_public.users where id = $1`,
            [payload.id]
          )
        ),
      catch: (error) =>
        new DatabaseQueryError({ query: "get_user", error }),
    });

    const user = rows[0];
    
    // 3. Check if user exists (might be deleted)
    if (!user) {
      yield* Effect.logWarning({
        event: "user_not_found",
        userId: payload.id,
        message: "User not found for password reset",
      });
      // Don't fail - user might have been deleted
      return;
    }

    // 4. Queue email with retry logic
    yield* Effect.tryPromise({
      try: () =>
        addJob("send_email", {
          options: {
            to: payload.email,
            subject: "Password reset",
          },
          template: "password_reset.mjml",
          variables: {
            token: payload.token,
            verifyLink: `${process.env.ROOT_URL}/reset?userId=${encodeURIComponent(
              user.id
            )}&token=${encodeURIComponent(payload.token)}`,
          },
        }),
      catch: (error) =>
        new EmailQueueError({ reason: String(error) }),
    }).pipe(
      // Retry up to 3 times with exponential backoff
      Effect.retry({
        schedule: Schedule.exponential("100 millis"),
        times: 3,
      })
    );

    // 5. Log success
    yield* Effect.log({
      event: "password_reset_queued",
      userId: user.id,
      email: payload.email,
    });
  }).pipe(
    // Handle errors with pattern matching
    Effect.catchTags({
      PayloadValidationError: (error) =>
        Effect.gen(function* () {
          yield* Effect.logError(`Invalid payload: ${error.errors}`);
          // Re-throw so graphile-worker marks as failed
          yield* Effect.fail(error);
        }),
      DatabaseQueryError: (error) =>
        Effect.gen(function* () {
          yield* Effect.logError(`Database error: ${error.query}`);
          yield* Effect.fail(error);
        }),
      EmailQueueError: (error) =>
        Effect.gen(function* () {
          yield* Effect.logError(`Failed to queue email: ${error.reason}`);
          // Fail so graphile-worker retries
          yield* Effect.fail(error);
        }),
    }),
    // Ensure cleanup happens even on interruption
    Effect.ensuring(Effect.log("Task cleanup complete"))
  )
);
```

#### 2.2 Test the Migration
```bash
# Keep old file as backup
mv worker/tasks/user__forgot_password.js worker/tasks/user__forgot_password.js.bak

# Test that worker can load the .ts file
timeout 5 bun worker || true

# Should see: task names: '..., user__forgot_password, ...'

# Test a job (if you have a test job function)
# bun run test:worker
```

#### 2.3 Verify
- [ ] Worker discovers the task
- [ ] TypeScript compiles without errors
- [ ] Schema validation works
- [ ] Error handling works
- [ ] Logging is structured

### Phase 3: Remaining Tasks (30 min each)

Migrate the remaining 6 tasks following the same pattern:

#### 3.1 `user_emails__send_verification.ts`
```typescript
import { Effect, Schedule } from "effect";
import * as S from "effect/Schema";
import { effectTask } from "../effectTask.js";
import { UserEmailsSendVerificationPayload } from "../schemas.js";

const MIN_INTERVAL_MS = 1000 * 60 * 3; // 3 minutes

export default effectTask((rawPayload, { addJob, withPgClient }) =>
  Effect.gen(function* () {
    const payload = yield* S.decodeUnknown(UserEmailsSendVerificationPayload)(rawPayload);
    
    // Fetch user email with verification token
    const { rows } = yield* Effect.tryPromise({
      try: () =>
        withPgClient((client) =>
          client.query(
            `
            select
              user_emails.id,
              email,
              verification_token,
              username,
              name,
              extract(epoch from now()) - extract(epoch from verification_email_sent_at) as seconds_since_verification_sent
            from app_public.user_emails
              inner join app_private.user_email_secrets
                on user_email_secrets.user_email_id = user_emails.id
              inner join app_public.users
                on users.id = user_emails.user_id
            where user_emails.id = $1
              and user_emails.is_verified is false
            `,
            [payload.id]
          )
        ),
      catch: (error) => new DatabaseQueryError({ query: "get_user_email", error }),
    });

    const userEmail = rows[0];
    
    if (!userEmail) {
      yield* Effect.logWarning(`User email ${payload.id} not found or already verified`);
      return;
    }

    // Check rate limit
    if (
      userEmail.seconds_since_verification_sent != null &&
      userEmail.seconds_since_verification_sent < MIN_INTERVAL_MS / 1000
    ) {
      yield* Effect.logInfo("Email sent too recently, skipping");
      return;
    }

    // Queue email
    yield* Effect.tryPromise({
      try: () =>
        addJob("send_email", {
          options: {
            to: userEmail.email,
            subject: "Please verify your email address",
          },
          template: "verify_email.mjml",
          variables: {
            token: userEmail.verification_token,
            verifyLink: `${process.env.ROOT_URL}/verify?id=${encodeURIComponent(
              String(payload.id)
            )}&token=${encodeURIComponent(userEmail.verification_token)}`,
            username: userEmail.username,
            name: userEmail.name,
          },
        }),
      catch: (error) => new EmailQueueError({ reason: String(error) }),
    });

    // Update sent timestamp
    yield* Effect.tryPromise({
      try: () =>
        withPgClient((client) =>
          client.query(
            "update app_private.user_email_secrets set verification_email_sent_at = now() where user_email_id = $1",
            [payload.id]
          )
        ),
      catch: (error) => new DatabaseQueryError({ query: "update_sent_at", error }),
    });

    yield* Effect.log({ event: "verification_email_sent", userEmailId: payload.id });
  })
);
```

#### 3.2 `user__send_delete_account_email.ts`
```typescript
import { Effect } from "effect";
import * as S from "effect/Schema";
import { effectTask } from "../effectTask.js";
import { UserSendAccountDeletionEmailPayload } from "../schemas.js";

export default effectTask((rawPayload, { addJob }) =>
  Effect.gen(function* () {
    const payload = yield* S.decodeUnknown(UserSendAccountDeletionEmailPayload)(rawPayload);

    yield* Effect.tryPromise({
      try: () =>
        addJob("send_email", {
          options: {
            to: payload.email,
            subject: "Confirmation required: really delete account?",
          },
          template: "delete_account.mjml",
          variables: {
            token: payload.token,
            deleteAccountLink: `${process.env.ROOT_URL}/settings?delete_token=${encodeURIComponent(
              payload.token
            )}`,
          },
        }),
      catch: (error) => new EmailQueueError({ reason: String(error) }),
    });

    yield* Effect.log({ event: "delete_account_email_sent", email: payload.email });
  })
);
```

#### 3.3 `user__forgot_password_unregistered_email.ts`
```typescript
import { Effect } from "effect";
import * as S from "effect/Schema";
import { effectTask } from "../effectTask.js";
import { UserForgotPasswordUnregisteredEmailPayload } from "../schemas.js";
import packageJson from "../../package.json" with { type: "json" };

const projectName = packageJson.projectName ?? packageJson.name;

export default effectTask((rawPayload, { addJob }) =>
  Effect.gen(function* () {
    const payload = yield* S.decodeUnknown(UserForgotPasswordUnregisteredEmailPayload)(rawPayload);

    yield* Effect.tryPromise({
      try: () =>
        addJob("send_email", {
          options: {
            to: payload.email,
            subject: `Password reset request failed: you don't have a ${projectName} account`,
          },
          template: "password_reset_unregistered.mjml",
          variables: {
            url: process.env.ROOT_URL,
          },
        }),
      catch: (error) => new EmailQueueError({ reason: String(error) }),
    });

    yield* Effect.log({ event: "unregistered_password_reset_sent", email: payload.email });
  })
);
```

#### 3.4 `user__audit.ts`
```typescript
import { Effect } from "effect";
import * as S from "effect/Schema";
import { effectTask } from "../effectTask.js";
import { UserAuditPayload } from "../schemas.js";
import packageJson from "../../package.json" with { type: "json" };

const projectName = packageJson.projectName ?? packageJson.name;

export default effectTask((rawPayload, { addJob, withPgClient, job }) =>
  Effect.gen(function* () {
    const payload = yield* S.decodeUnknown(UserAuditPayload)(rawPayload);

    // Build subject and description based on type
    let subject: string;
    let actionDescription: string;

    switch (payload.type) {
      case "added_email":
        subject = "You added an email to your account";
        actionDescription = `You added the email '${payload.extra2}' to your account.`;
        break;
      case "removed_email":
        subject = "You removed an email from your account";
        actionDescription = `You removed the email '${payload.extra2}' from your account.`;
        break;
      case "linked_account":
        subject = "You linked a third-party OAuth provider to your account";
        actionDescription = `You linked a third-party OAuth provider ('${payload.extra1}') to your account.`;
        break;
      case "unlinked_account":
        subject = "You removed a link between your account and a third-party OAuth provider";
        actionDescription = `You removed a link between your account and a third-party OAuth provider ('${payload.extra1}').`;
        break;
      case "reset_password":
        subject = "You reset your password";
        actionDescription = "You reset your password.";
        break;
      case "change_password":
        subject = "You changed your password";
        actionDescription = "You changed your password.";
        break;
    }

    // Get user
    const { rows: userRows } = yield* Effect.tryPromise({
      try: () =>
        withPgClient((client) =>
          client.query("select * from app_public.users where id = $1", [payload.user_id])
        ),
      catch: (error) => new DatabaseQueryError({ query: "get_user", error }),
    });

    const user = userRows[0];

    if (!user) {
      yield* Effect.logError(`User ${payload.user_id} no longer exists`);
      return;
    }

    // Don't send if action happened immediately after account creation
    const createdAtMs = new Date(user.created_at).getTime();
    const jobCreatedAtMs = new Date(job.created_at).getTime();
    if (Math.abs(createdAtMs - jobCreatedAtMs) < 2000) {
      yield* Effect.logInfo(`Skipping audit for ${payload.user_id} - action at account creation`);
      return;
    }

    // Get verified emails
    const { rows: emailRows } = yield* Effect.tryPromise({
      try: () =>
        withPgClient((client) =>
          client.query(
            "select * from app_public.user_emails where user_id = $1 and is_verified is true order by id asc",
            [payload.user_id]
          )
        ),
      catch: (error) => new DatabaseQueryError({ query: "get_emails", error }),
    });

    if (emailRows.length === 0) {
      yield* Effect.fail(new Error("Could not find verified emails for user"));
    }

    const emails = emailRows.map((e) => e.email);

    // Queue email
    yield* Effect.tryPromise({
      try: () =>
        addJob("send_email", {
          options: {
            to: emails,
            subject: `[${projectName}] ${subject}`,
          },
          template: "account_activity.mjml",
          variables: {
            actionDescription,
          },
        }),
      catch: (error) => new EmailQueueError({ reason: String(error) }),
    });

    yield* Effect.log({ event: "audit_email_sent", userId: payload.user_id, type: payload.type });
  })
);
```

#### 3.5 `sponsor_webhook.ts`
```typescript
import { Effect } from "effect";
import * as S from "effect/Schema";
import { effectTask } from "../effectTask.js";
import { SponsorWebhookPayload } from "../schemas.js";

export default effectTask((rawPayload, { addJob }) =>
  Effect.gen(function* () {
    const payload = yield* S.decodeUnknown(SponsorWebhookPayload)(rawPayload);

    if (payload.status === "active") {
      yield* Effect.tryPromise({
        try: () => addJob("enable_sponsorship", { tier: payload.tier }),
        catch: (error) => new Error(`Failed to queue enable_sponsorship: ${error}`),
      });
      yield* Effect.log({ event: "sponsorship_enabled", tier: payload.tier });
    }

    if (payload.status === "cancelled") {
      // TODO: Calculate last payment date and schedule disable
      yield* Effect.logWarning("Sponsorship cancelled - disable logic not implemented");
      // await addJob("disable_sponsorship", {}, { runAt: last_payment + (DAYS * 30) })
    }
  })
);
```

#### 3.6 Convert `send_email.js` to TypeScript

This is the most complex task. Two approaches:

**Option A: Keep as .js for now** (simpler)
- Already has `@ts-check`
- Already uses ESM
- Just fix the `@ts-expect-error` comments
- Add Effect wrapper for MJML rendering

**Option B: Full TypeScript** (better)
- Rename to `.ts`
- Create Effect service for email transport
- Use Effect for template loading/caching
- Full type safety

Recommend **Option A** for MVP, **Option B** for future enhancement.

### Phase 4: Optional Enhancements

#### 4.1 Email Transport as Effect Service
**File:** `worker/services/EmailTransport.ts`
```typescript
import { Effect, Layer, Context } from "effect";
import nodemailer from "nodemailer";
import { EmailSendError } from "../errors.js";
import getTransport from "../transport.js";

export class EmailTransport extends Context.Tag("EmailTransport")<
  EmailTransport,
  {
    sendMail: (options: any) => Effect.Effect<any, EmailSendError>;
    getTestUrl: (info: any) => Effect.Effect<string | null>;
  }
>() {}

export const EmailTransportLive = Layer.effect(
  EmailTransport,
  Effect.gen(function* () {
    const transport = yield* Effect.promise(() => getTransport());

    return {
      sendMail: (options) =>
        Effect.tryPromise({
          try: () => transport.sendMail(options),
          catch: (error) =>
            new EmailSendError({
              recipient: options.to,
              reason: String(error),
            }),
        }),
      getTestUrl: (info) =>
        Effect.sync(() => nodemailer.getTestMessageUrl(info)),
    };
  })
);
```

Update `worker/runtime.ts`:
```typescript
import { EmailTransportLive } from "./services/EmailTransport.js";

const WorkerLive = Layer.mergeAll(
  NodeRuntime.layer,
  EmailTransportLive,
);
```

#### 4.2 Add Observability
```typescript
import { Effect } from "effect";

// In tasks, add spans for observability
Effect.gen(function* () {
  // ... task logic
}).pipe(
  Effect.withSpan("user__forgot_password", {
    attributes: { userId: payload.id },
  })
)
```

#### 4.3 Add Rate Limiting
```typescript
import { Effect, RateLimiter } from "effect";

// In runtime.ts or task
const emailRateLimiter = RateLimiter.make({
  algorithm: "token-bucket",
  capacity: 100,
  refillRate: 10,
  refillInterval: "1 second",
});

// In tasks
yield* Effect.scoped(
  Effect.gen(function* () {
    yield* emailRateLimiter.take(1);
    // Send email
  })
);
```

## Testing Strategy

### Unit Tests
```typescript
// worker/__tests__/user__forgot_password.test.ts
import { Effect, Exit } from "effect";
import { describe, it, expect } from "bun:test";
import userForgotPassword from "../tasks/user__forgot_password.js";

describe("user__forgot_password", () => {
  it("should validate payload", async () => {
    const invalidPayload = { id: "not-a-uuid", email: "bad", token: "short" };
    
    // Mock helpers
    const helpers = {
      addJob: () => Promise.resolve(),
      withPgClient: () => Promise.resolve({ rows: [] }),
    };

    // Run task
    const result = await Effect.runPromiseExit(
      userForgotPassword(invalidPayload, helpers)
    );

    expect(Exit.isFailure(result)).toBe(true);
  });

  it("should handle missing user gracefully", async () => {
    const validPayload = {
      id: "123e4567-e89b-12d3-a456-426614174000",
      email: "test@example.com",
      token: "a".repeat(32),
    };

    const helpers = {
      addJob: () => Promise.resolve(),
      withPgClient: () => Promise.resolve({ rows: [] }),
    };

    const result = await Effect.runPromiseExit(
      userForgotPassword(validPayload, helpers)
    );

    // Should succeed (not fail) when user not found
    expect(Exit.isSuccess(result)).toBe(true);
  });
});
```

### Integration Tests
```bash
# Test worker can start and discover tasks
timeout 5 bun worker

# Test with a real job (requires database)
# bun run scripts/testWorkerJob.ts
```

### Manual Testing Checklist
- [ ] Worker starts without errors
- [ ] All 7 tasks discovered
- [ ] TypeScript compilation passes
- [ ] Schema validation catches bad payloads
- [ ] Retry logic works for transient failures
- [ ] Logging is structured and readable
- [ ] SIGTERM/SIGINT handled gracefully

## Rollback Plan

If issues arise, rollback is simple:

```bash
# Revert all .ts files to .js.bak
for file in worker/tasks/*.ts; do
  backup="${file%.ts}.js.bak"
  if [ -f "$backup" ]; then
    mv "$backup" "${file%.ts}.js"
    rm "$file"
  fi
done

# Remove config
rm worker/.graphile-workerrc
rm worker/tsconfig.json
```

## Production Deployment

### Option 1: Bun in Production (Recommended)
- No changes needed
- Bun transpiles `.ts` on the fly
- Fast startup, low memory

### Option 2: Pre-compile TypeScript
```json
{
  "scripts": {
    "worker:build": "tsc -p worker/tsconfig.json",
    "worker:prod": "cd worker && graphile-worker"
  }
}
```

Update `worker/tsconfig.json`:
```json
{
  "compilerOptions": {
    "noEmit": false,  // Enable compilation
    "outDir": "./dist"
  }
}
```

## Performance Considerations

### Effect Overhead
- Effect is zero-cost at runtime (compiles to plain JS)
- Schema validation adds ~1ms per payload
- Retry logic is lazy (no overhead if not needed)

### Memory Usage
- Effect uses fiber-based concurrency (lighter than OS threads)
- Managed runtime pools resources
- No memory leaks from unclosed connections

### Benchmarks (Expected)
- Schema validation: ~1ms per task
- Effect overhead: ~0.1ms per task
- Total overhead: <2% vs plain JS

## Key Decisions & Rationale

### Why Effect over plain TypeScript?
- **Runtime validation** - Catches bad data before processing
- **Type-safe errors** - Pattern match on error types
- **Built-in retry** - No manual setTimeout/Promise.retry
- **Resource safety** - Automatic cleanup on interruption
- **Testability** - Pure functions, no side effects
- **Consistency** - Already using Effect in scripts/server

### Why runFork over runPromise?
- **Interruption** - Can cancel long-running jobs
- **Cleanup** - Finalizers run on SIGTERM
- **Observability** - Can inspect fiber state
- **Production ready** - Handles signals correctly

### Why gradual migration?
- **No downtime** - Old and new tasks work together
- **Low risk** - Can test each task independently
- **Easy rollback** - Keep `.js.bak` files
- **Learn as we go** - Build expertise incrementally

## Common Pitfalls & Solutions

### Pitfall 1: Forgetting to validate payload
**Solution:** Always start tasks with Schema decode
```typescript
const payload = yield* S.decodeUnknown(Schema)(rawPayload);
```

### Pitfall 2: Using runPromise instead of runFork
**Solution:** Always use `runWorkerEffect` wrapper

### Pitfall 3: Not handling interruption
**Solution:** Use `Effect.ensuring` for cleanup
```typescript
Effect.gen(function* () {
  // ... task logic
}).pipe(
  Effect.ensuring(Effect.log("Cleanup complete"))
)
```

### Pitfall 4: Assuming payload types without validation
**Solution:** Never cast `rawPayload` - always validate

## Resources & References

### Documentation
- [Effect Documentation](https://effect.website/docs/introduction)
- [Graphile Worker Docs](https://worker.graphile.org/docs)
- [Effect Schema Guide](https://effect.website/docs/schema/introduction)
- [Effect Error Handling](https://effect.website/docs/error-management/expected-errors)

### Internal Docs
- `docs/effect-docs.md` - Effect idioms and APIs
- `AGENTS.md` - Project architecture
- `scripts/dbSetup.ts` - Example of Effect usage with Postgres

### Similar Projects
- `scripts/dbSetup.ts` - Uses Effect for database setup
- `server/envSchema.ts` - Uses Effect Schema for env validation
- `server/app.ts` - Uses Effect Schema in routes

## Checklist for Implementation

### Phase 1: Foundation ✅
- [ ] Create `worker/.graphile-workerrc`
- [ ] Create `worker/tsconfig.json`
- [ ] Update root `tsconfig.json` to include worker
- [ ] Create `worker/schemas.ts` with all payload schemas
- [ ] Create `worker/errors.ts` with tagged errors
- [ ] Create `worker/runtime.ts` with ManagedRuntime
- [ ] Create `worker/effectTask.ts` wrapper
- [ ] Update `worker/types.d.ts` with GraphileWorker.Tasks
- [ ] Test: `timeout 5 bun worker` shows no errors

### Phase 2: Proof of Concept ✅
- [ ] Backup: `cp user__forgot_password.js user__forgot_password.js.bak`
- [ ] Create `worker/tasks/user__forgot_password.ts`
- [ ] Test: Worker discovers task
- [ ] Test: Schema validation works
- [ ] Test: Error handling works
- [ ] Verify: No regressions

### Phase 3: Remaining Tasks ✅
- [ ] Migrate `user_emails__send_verification.ts`
- [ ] Migrate `user__send_delete_account_email.ts`
- [ ] Migrate `user__forgot_password_unregistered_email.ts`
- [ ] Migrate `user__audit.ts`
- [ ] Migrate `sponsor_webhook.ts`
- [ ] Test each task individually
- [ ] Run full test suite

### Phase 4: Cleanup ✅
- [ ] Remove all `.js.bak` files (after testing)
- [ ] Update `package.json` scripts if needed
- [ ] Update documentation
- [ ] Add test coverage
- [ ] Production deployment test

## Success Criteria

✅ All 7 tasks migrated to TypeScript
✅ Worker starts without errors
✅ All tasks discovered by graphile-worker  
✅ Schema validation catches invalid payloads
✅ Error handling is type-safe
✅ Retry logic works correctly
✅ Logging is structured
✅ Tests pass
✅ No performance degradation
✅ Graceful shutdown works

## Timeline

- **Phase 1 (Foundation):** 1-2 hours
- **Phase 2 (Proof of Concept):** 30-45 minutes
- **Phase 3 (Remaining Tasks):** 3 hours (30 min × 6 tasks)
- **Phase 4 (Cleanup & Testing):** 1 hour

**Total:** 5-6 hours (can be spread over multiple sessions)

## Next Steps

To begin implementation:

1. **Start with Phase 1** - Create all foundation files
2. **Test each file** - Run `bun typecheck` and `bun worker`
3. **Migrate one task** - Proof of concept with `user__forgot_password`
4. **Validate approach** - Ensure everything works before proceeding
5. **Roll out gradually** - One task at a time
6. **Monitor in production** - Watch logs and error rates

Ready to start? Begin with creating `worker/.graphile-workerrc`!
