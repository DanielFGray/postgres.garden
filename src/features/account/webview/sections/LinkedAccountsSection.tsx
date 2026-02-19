import * as Effect from "effect/Effect";
import { Atom, AtomRegistry } from "fibrae";
import { apiRequest } from "../api";

type LinkedAccount = {
  id: string;
  service: string;
  identifier: string;
  created_at: string;
};

const accountsAtom = Atom.make<LinkedAccount[]>([]);
const errorAtom = Atom.make<string | null>(null);
const loadingAtom = Atom.make(true);
const unlinkingAtom = Atom.make<string | null>(null);

function loadAccounts(registry: AtomRegistry.Registry) {
  registry.set(loadingAtom, true);
  registry.set(errorAtom, null);
  apiRequest<LinkedAccount[]>("/api/me/authentications")
    .then((data) => {
      registry.set(accountsAtom, data);
    })
    .catch((err: unknown) => {
      registry.set(errorAtom, err instanceof Error ? err.message : String(err));
    })
    .finally(() => {
      registry.set(loadingAtom, false);
    });
}

let initialized = false;

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

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
  Effect.gen(function* () {
    const registry = yield* AtomRegistry.AtomRegistry;

    if (!initialized) {
      initialized = true;
      loadAccounts(registry);
    }

    const accounts = yield* Atom.get(accountsAtom);
    const error = yield* Atom.get(errorAtom);
    const loading = yield* Atom.get(loadingAtom);
    const unlinking = yield* Atom.get(unlinkingAtom);

    function handleUnlink(account: LinkedAccount) {
      registry.set(unlinkingAtom, account.id);
      void apiRequest("/api/me/authentications/" + account.id, "DELETE")
        .then(() => {
          loadAccounts(registry);
        })
        .catch((err: unknown) => {
          registry.set(errorAtom, err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          registry.set(unlinkingAtom, null);
        });
    }

    if (loading) {
      return <div class="section-loading">Loading linked accounts...</div>;
    }

    if (error) {
      return (
        <div class="section-error">
          <i class="codicon codicon-error" />
          <span>{error}</span>
          <button class="button" onClick={() => loadAccounts(registry)}>Retry</button>
        </div>
      );
    }

    return (
      <div class="linked-accounts-section">
        <div class="section-header">
          <h2>Linked Accounts</h2>
        </div>

        <div class="linked-accounts-list">
          {accounts.length === 0 ? (
            <div class="field">
              <div class="field-value">
                <span class="field-empty">
                  No linked accounts. Connect a service below.
                </span>
              </div>
            </div>
          ) : (
            accounts.map((account) => (
              <div key={account.id} class="linked-account-card">
                <div class="linked-account-icon">
                  <i class={`codicon ${serviceIcon(account.service)}`} />
                </div>
                <div class="linked-account-details">
                  <div class="linked-account-service">
                    {capitalize(account.service)}
                  </div>
                  <div class="linked-account-meta">
                    <span class="linked-account-identifier">
                      {account.identifier}
                    </span>
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
    );
  });
