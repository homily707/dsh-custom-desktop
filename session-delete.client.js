//#region permanent session delete (dsh-custom-desktop)
/**
 * Contribute one action to DSH's shared native-style session context menu.
 * The Host owns validation and filesystem writes; client state is only a hint.
 */
function installSessionDelete(ctx) {
  ctx.inject(["contextMenus", "sessions"], (scope) => {
    scope.effect(() => scope.contextMenus.register({
      id: "custom-desktop.session-delete",
      target: "session",
      order: 9999,
      observe: () => [scope.sessions.list],
      resolve: ({ sessionId, displayTitle }) => {
        const summary = scope.sessions.list.getSnapshot()?.byId?.[sessionId];
        const isBusy = summary?.running === true
          || Boolean(summary?.pendingInteraction)
          || (summary?.runningSubagentCount ?? 0) > 0;
        return [{
          id: "delete-session",
          label: "永久删除会话",
          icon: { key: "workspace.delete" },
          danger: true,
          afterContent: true,
          disabled: isBusy,
          failureLabel: "删除失败，请检查会话状态或宿主日志",
          run: async () => {
            // Recheck the selected ID rather than using the current session.
            const current = scope.sessions.list.getSnapshot()?.byId?.[sessionId];
            if (current?.running || current?.pendingInteraction
              || (current?.runningSubagentCount ?? 0) > 0)
              throw new Error("会话正在运行或等待交互，请先停止任务");
            const response = await fetch(new URL("api/custom-desktop/delete-session", document.baseURI), {
              method: "POST",
              credentials: "same-origin",
              headers: {
                "content-type": "application/json",
                "x-custom-desktop-delete": "1"
              },
              body: JSON.stringify({ sessionId })
            });
            const result = await response.json().catch(() => null);
            if (!response.ok || result?.ok !== true)
              throw new Error(result?.error || "删除失败 (HTTP " + response.status + ")");
            try { await scope.sessions.refresh?.(); }
            catch (error) { console.warn("custom-desktop: session list refresh failed", error); }
            scope.contextMenus.notify?.("会话已永久删除", true);
          }
        }];
      }
    }), "custom-desktop: session delete menu");
  });
}
//#endregion
