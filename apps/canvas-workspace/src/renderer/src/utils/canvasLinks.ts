const CANVAS_ROUTE = '/';

export function buildCanvasNodeLink(workspaceId: string, nodeId: string): string {
  const url = new URL(window.location.href);
  const params = new URLSearchParams({ workspaceId, nodeId });
  url.hash = `${CANVAS_ROUTE}?${params.toString()}`;
  return url.toString();
}

export function parseCanvasLocation(location: string): {
  path: string;
  params: URLSearchParams;
} {
  const [rawPath, rawQuery = ''] = location.split('?');
  return {
    path: rawPath || CANVAS_ROUTE,
    params: new URLSearchParams(rawQuery),
  };
}
