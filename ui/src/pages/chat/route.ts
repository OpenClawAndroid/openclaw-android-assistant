import type { RouteLocation } from "@openclaw/uirouter";
import { definePage } from "@openclaw/uirouter";
import { INTERNAL_SESSION_PATH_PARAM, pathForRoute, routePageSpec } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { gatewayPresentationScope } from "../../app/gateway-presentation-scope.ts";
import type { BoardFace } from "../../lib/board/settings.ts";
import type { ChatRouteData } from "./session-route-data.ts";

function sessionLoaderDeps(
  face: BoardFace,
  context: ApplicationContext,
  location: RouteLocation,
): string {
  const search = new URLSearchParams(location.search);
  const bridgedPath =
    location.pathname === pathForRoute(face, context.basePath)
      ? search.get(INTERNAL_SESSION_PATH_PARAM)
      : null;
  if (bridgedPath) {
    search.delete(INTERNAL_SESSION_PATH_PARAM);
  }
  const serializedSearch = search.toString();
  return `${gatewayPresentationScope(context.gateway).key}\u0000${bridgedPath ?? location.pathname}\u0000${
    serializedSearch ? `?${serializedSearch}` : ""
  }`;
}

function sessionPage(face: BoardFace) {
  return definePage({
    ...routePageSpec(face),
    // The application router temporarily maps dynamic session URLs onto the
    // static face route. Both locations describe the same loader match.
    loaderDeps: (context: ApplicationContext, location: RouteLocation) =>
      sessionLoaderDeps(face, context, location),
    loader: async (context: ApplicationContext, { location, signal, cause, deps }) => {
      const { loadChatRoute } = await import("./route-loader.ts");
      const current =
        cause === "revalidate"
          ? context.router
              .getState()
              .matches.find((match) => match.routeId === face && match.deps === deps)
          : undefined;
      // SAFETY: Matching this face selects only this page's loadChatRoute result.
      const data = current?.data as ChatRouteData | undefined;
      // Revalidating an established link must not adopt another session with the same prefix.
      return await loadChatRoute(
        context,
        location,
        face,
        signal,
        cause === "revalidate"
          ? { sessionKey: data?.kind === "session" ? data.sessionKey : undefined }
          : undefined,
      );
    },
    component: () =>
      Promise.all([
        import("./chat-page.ts"),
        import("./route-view.ts"),
        import("../../styles/chat/composer-progress.css"),
        import("../../styles/chat/composer-queue.css"),
        import("../../styles/chat/composer-status.css"),
      ]).then(([, { renderChatRoute, sessionRenderOwnerKey }]) => ({
        header: true,
        // ChatPage's bounded inner cache owns per-session teardown, so session
        // routes share the outer owner while their data and URL keep changing.
        renderOwnerKey: sessionRenderOwnerKey,
        retainOnNavigate: true,
        render: renderChatRoute,
      })),
  });
}

export const pages = [sessionPage("chat"), sessionPage("dashboard")] as const;
