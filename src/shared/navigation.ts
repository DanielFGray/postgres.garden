export const navigateTo = (href: string, options?: { replace?: boolean }) => {
  const url = new URL(href, window.location.origin);

  if (options?.replace) {
    window.history.replaceState(null, "", url);
  } else {
    window.history.pushState(null, "", url);
  }

  window.dispatchEvent(new PopStateEvent("popstate"));
};
