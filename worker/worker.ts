// @entrypoint: graphile-worker calls the tasks, which run with the worker's context.
import { EmailDelivery, invitationTask } from "@danielfgray/stompbox/mail";
import { effectTask, runWorker, WorkerError } from "@danielfgray/stompbox/worker";
import { Config, Context, Effect, Layer, Option, Path, Ref } from "effect";

import { rootUrl } from "../server/config.js";
import {
  AccountMail,
  AuditEvent,
  DeleteAccount,
  ForgotPassword,
  ForgotPasswordUnregistered,
  SendVerification,
} from "./accountMail.js";
import { EmailDeliveryLive, QueuedEmail } from "./email/mailKinds.js";
import { ExpiredPlaygrounds, PruneExpiredPlaygrounds } from "./expiredPlaygrounds.js";
import { Invitations } from "./invitations.js";
import { Sponsorship, SponsorshipEvent } from "./sponsorship.js";

/**
 * Background jobs run in the server process as a graphile-worker library. The
 * jobs, crontab and templates live in `worker/`. No other process runs
 * jobs: the graphile-worker CLI only installs the job schema (`worker:schema`).
 *
 * Building the layer starts the runner in the background, so the server keeps
 * answering while graphile-worker runs its migrations, and keeps serving when
 * the runner cannot start. Build it after the dependency wait: a runner that
 * starts before Postgres answers fails for good. The runner stops when the
 * layer's scope closes and waits for its running jobs, so release the layer
 * before the database pools.
 */
export class Worker extends Context.Service<Worker>()("postgres-garden/worker", {
  make: Effect.gen(function* () {
    // A runner that has not started yet is not failed: the health check reports
    // only a runner that stopped or could not start.
    const failed = yield* Ref.make(false);
    const started = yield* Ref.make(Option.none<{ readonly isRunning: Effect.Effect<boolean> }>());
    yield* start.pipe(
      Effect.flatMap((runner) => Ref.set(started, Option.some(runner))),
      Effect.catch((error) =>
        Effect.logError(error.message, error.cause).pipe(Effect.andThen(Ref.set(failed, true))),
      ),
      Effect.forkScoped,
    );
    return {
      /** False once the runner has stopped or failed to start. */
      isRunning: Effect.gen(function* () {
        if (yield* Ref.get(failed)) return false;
        const runner = yield* Ref.get(started);
        return Option.isNone(runner) || (yield* runner.value.isRunning);
      }),
    } as const;
  }),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide(
      Layer.mergeAll(
        AccountMail.layer,
        EmailDeliveryLive,
        ExpiredPlaygrounds.layer,
        Invitations.layer,
        Sponsorship.layer,
      ),
    ),
  );
}

/**
 * Starts the runner and returns once it runs.
 *
 * Paths resolve from the working directory: the production server is one
 * bundle in `dist/`, so a path relative to this module would point there.
 */
const start = Effect.gen(function* () {
  const connectionString = yield* Config.Redacted("DATABASE_URL").pipe(
    Effect.mapError((cause) => new WorkerError({ message: "Worker failed to start", cause })),
  );
  const path = yield* Path.Path;
  const context = yield* Effect.context<EmailDelivery>();
  const email = yield* EmailDelivery;
  const mail = yield* AccountMail;
  const invitations = yield* Invitations;
  const playgrounds = yield* ExpiredPlaygrounds;
  const sponsorship = yield* Sponsorship;
  const task = effectTask(context);
  // No page accepts an invitation yet; the path is where the link will point.
  const invite = {
    job: "organization_invitations__send_invite",
    group: "organization",
    acceptPath: "/invitations/accept",
    rootUrl,
  } as const;
  return yield* runWorker({
    connectionString,
    crontabFile: path.resolve("worker/crontab"),
    taskList: {
      send_email: task(QueuedEmail, email.send),
      user__audit: task(AuditEvent, (event, helpers) => mail.audit(event, helpers.job.created_at)),
      user__forgot_password: task(ForgotPassword, mail.forgotPassword),
      user__forgot_password_unregistered_email: task(
        ForgotPasswordUnregistered,
        mail.forgotPasswordUnregistered,
      ),
      user__send_delete_account_email: task(DeleteAccount, mail.sendDeleteAccount),
      user_emails__send_verification: task(SendVerification, mail.sendVerification),
      prune_expired_playgrounds: task(PruneExpiredPlaygrounds, playgrounds.prune),
      sponsor_webhook: task(SponsorshipEvent, sponsorship.apply),
      [invite.job]: invitationTask({ ...invite, load: invitations.load })(context),
    },
  });
});
