const PROJECT_ROUTE_PREFIX = "#/project/";

export function buildProjectHash(localProjectKey) {
  const key = String(localProjectKey || "").trim();
  if (!key) {
    throw new Error("A project route needs a local project key.");
  }
  return `${PROJECT_ROUTE_PREFIX}${encodeURIComponent(key)}`;
}

export function parseAppRoute(hash = "") {
  const value = String(hash || "");
  if (value === "" || value === "#" || value === "#/") {
    return { name: "hub" };
  }
  if (!value.startsWith(PROJECT_ROUTE_PREFIX)) {
    return { name: "not-found" };
  }
  const encodedKey = value.slice(PROJECT_ROUTE_PREFIX.length);
  if (!encodedKey || encodedKey.includes("/")) {
    return { name: "not-found" };
  }
  try {
    const localProjectKey = decodeURIComponent(encodedKey).trim();
    return localProjectKey ? { name: "project", localProjectKey } : { name: "not-found" };
  } catch (error) {
    if (error instanceof URIError) {
      return { name: "not-found" };
    }
    throw error;
  }
}
