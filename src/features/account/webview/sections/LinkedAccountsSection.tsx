import { createSignal, refresh, For, Show } from "solid-js";
import type * as Effect from "effect/Effect";
import { apiCall } from "../api";
import { formatDate } from "../format";
import { createRequest, runRequest } from "../../../webview/request";
import { SectionBoundary } from "../SectionBoundary";

const loadAccounts = () =>
  apiCall("account.linked_accounts.load", (api) => api.apiUsers.meAuthentications({}));

type LinkedAccount = Effect.Success<ReturnType<typeof loadAccounts>>[number];

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

export const LinkedAccountsSection = () => {
  const accounts = createRequest(loadAccounts);
  const [unlinking, setUnlinking] = createSignal<string | null>(null);
  const [mutationError, setMutationError] = createSignal<string | null>(null);

  function handleUnlink(account: LinkedAccount) {
    setUnlinking(account.id);
    setMutationError(null);
    void runRequest(
      apiCall("account.linked_accounts.unlink", (api) =>
        api.apiUsers.deleteMeAuthentication({ params: { id: account.id } }),
      ),
    )
      .then(
        () => refresh(accounts),
        (error: Error) => setMutationError(error.message),
      )
      .finally(() => setUnlinking(null));
  }

  return (
    <SectionBoundary loading="Loading linked accounts..." retry={() => refresh(accounts)}>
      <div class="linked-accounts-section">
        <div class="section-header">
          <h2>Linked Accounts</h2>
        </div>

        <Show when={mutationError()}>
          {(message) => (
            <div class="section-error" style={{ "margin-bottom": "12px" }}>
              <i class="codicon codicon-error" />
              <span>{message()}</span>
            </div>
          )}
        </Show>

        <div class="linked-accounts-list">
          <Show
            when={accounts().length > 0}
            fallback={
              <div class="field">
                <div class="field-value">
                  <span class="field-empty">No linked accounts. Connect a service below.</span>
                </div>
              </div>
            }
          >
            <For each={accounts()}>
              {(account) => (
                <div class="linked-account-card">
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
                    disabled={unlinking() === account.id}
                    onClick={() => handleUnlink(account)}
                  >
                    {unlinking() === account.id ? "Unlinking..." : "Unlink"}
                  </button>
                </div>
              )}
            </For>
          </Show>
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
    </SectionBoundary>
  );
};
