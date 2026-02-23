import * as Effect from "effect/Effect";
import { Result } from "@effect-atom/atom";
import { Atom, AtomRegistry } from "fibrae";
import { apiRequest } from "../api";
import { formatDate } from "../format";

type LinkedAccount = {
  id: string;
  service: string;
  identifier: string;
  created_at: string;
};

const accountsAtom = Atom.make(
  apiRequest<LinkedAccount[]>("/api/me/authentications", "GET", undefined, {
    action: "account.linked_accounts.load",
  }),
);

const unlinkingAtom = Atom.make<string | null>(null);
const mutationErrorAtom = Atom.make<string | null>(null);

function capitalize(str: string) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function serviceIcon(service: string): string {
  switch (service.toLowerCase()) {
    case "github":
      return "codicon-github";
    default:
      return "codicon-link";
  }
}

export const LinkedAccountsSection = () =>
  Effect.gen(function*() {
    const registry = yield* AtomRegistry.AtomRegistry;
    const result = yield* Atom.get(accountsAtom);
    const unlinking = yield* Atom.get(unlinkingAtom);
    const mutationError = yield* Atom.get(mutationErrorAtom);

    function handleUnlink(account: LinkedAccount) {
      registry.set(unlinkingAtom, account.id);
      registry.set(mutationErrorAtom, null);
      void Effect.runFork(
        apiRequest("/api/me/authentications/" + account.id, "DELETE", undefined, {
          action: "account.linked_accounts.unlink",
        }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              registry.refresh(accountsAtom);
            }),
          ),
          Effect.catchAll((err) =>
            Effect.sync(() => {
              registry.set(mutationErrorAtom, err.message);
            }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              registry.set(unlinkingAtom, null);
            }),
          ),
        ),
      );
    }

    return Result.builder(result)
      .onInitial(() => <div class="section-loading">Loading linked accounts...</div>)
      .onError((error) => (
        <div class="section-error">
          <i class="codicon codicon-error" />
          <span>{error.message}</span>
          <button class="button" onClick={() => registry.refresh(accountsAtom)}>
            Retry
          </button>
        </div>
      ))
      .onSuccess((accounts) => (
        <div class="linked-accounts-section">
          <div class="section-header">
            <h2>Linked Accounts</h2>
          </div>

          {mutationError && (
            <div class="section-error" style={{ marginBottom: "12px" }}>
              <i class="codicon codicon-error" />
              <span>{mutationError}</span>
            </div>
          )}

          <div class="linked-accounts-list">
            {accounts.length === 0 ? (
              <div class="field">
                <div class="field-value">
                  <span class="field-empty">No linked accounts. Connect a service below.</span>
                </div>
              </div>
            ) : (
              accounts.map((account) => (
                <div key={account.id} class="linked-account-card">
                  <div class="linked-account-icon">
                    <i class={`codicon ${serviceIcon(account.service)}`} />
                  </div>
                  <div class="linked-account-details">
                    <div class="linked-account-service">{capitalize(account.service)}</div>
                    <div class="linked-account-meta">
                      <span class="linked-account-identifier">{account.identifier}</span>
                      <span class="linked-account-date">
                        Connected {formatDate(account.created_at)}
                      </span>
                    </div>
                  </div>
                  <button
                    class="button"
                    disabled={unlinking === account.id}
                    onClick={() => handleUnlink(account)}
                  >
                    {unlinking === account.id ? "Unlinking..." : "Unlink"}
                  </button>
                </div>
              ))
            )}
          </div>

          <div class="linked-accounts-connect">
            <div class="field">
              <label>Connect a Service</label>
              <div class="linked-accounts-connect-row">
                <button class="button" disabled>
                  <i class="codicon codicon-github" />
                  Connect GitHub
                </button>
                <span class="linked-accounts-connect-hint">
                  To connect GitHub, use the sign-in flow from the main interface.
                </span>
              </div>
            </div>
          </div>
        </div>
      ))
      .render();
  });
