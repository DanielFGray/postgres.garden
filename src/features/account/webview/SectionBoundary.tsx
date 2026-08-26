import { Errored, Loading } from "solid-js";
import type { JSX } from "@solidjs/web";

/**
 * The load/error chrome shared by every settings section. Children read their
 * request directly: pending reads suspend to `Loading`, failures land in
 * `Errored`. `retry` re-runs the request behind the boundary before resetting.
 */
export const SectionBoundary = (props: {
  loading: string;
  retry: () => void;
  children: JSX.Element;
}) => (
  <Errored
    fallback={(error, reset) => (
      <div class="section-error">
        <i class="codicon codicon-error" />
        <span>{String(error())}</span>
        <button
          class="button"
          onClick={() => {
            props.retry();
            reset();
          }}
        >
          Retry
        </button>
      </div>
    )}
  >
    <Loading fallback={<div class="section-loading">{props.loading}</div>}>
      {props.children}
    </Loading>
  </Errored>
);
