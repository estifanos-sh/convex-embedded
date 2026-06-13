import { api } from "~convex/_generated/api";
import type { Id } from "~convex/_generated/dataModel";
import type { OptimisticLocalStore } from "@convex-dev/embedded/browser";
import { client } from "./lib/client";
import { watch } from "./lib/watch";
import { clear, cx, h, svg } from "./ui";

type Todo = {
  _id: Id<"todos">;
  _creationTime: number;
  text: string;
  done: boolean;
};

export function renderTodos(): HTMLElement {
  const list = h("ul", { class: "flex flex-col" });

  const status = h("span", { class: "text-xs text-content-secondary tabular-nums" }, "");
  const errorLine = h("p", { class: "mb-3 hidden text-sm text-content-error" }, "");

  const input = h("input", {
    type: "text",
    placeholder: "Add a todo",
    autocomplete: "off",
    "aria-label": "Add a todo",
    class: cx(
      "block w-full grow rounded-md border bg-background-secondary p-1.5 px-2 text-sm",
      "text-content-primary placeholder-content-tertiary",
      "focus:border-border-selected focus:outline-hidden",
    ),
  }) as HTMLInputElement;

  const addButton = h(
    "button",
    {
      type: "submit",
      class: cx(
        "inline-flex items-center gap-1.5 rounded-md border border-white/30 bg-util-accent",
        "px-3 py-1.5 text-sm font-medium whitespace-nowrap text-white",
        "transition-colors disabled:cursor-not-allowed disabled:opacity-50",
      ),
    },
    "Add",
  ) as HTMLButtonElement;

  const inputForm = h(
    "form",
    { class: "mb-4 flex items-center gap-2" },
    input,
    addButton,
  ) as HTMLFormElement;

  const clearButton = h(
    "button",
    {
      type: "button",
      class: cx(
        "rounded-md px-2 py-1 text-xs text-content-secondary",
        "transition-colors hover:bg-background-tertiary hover:text-content-primary",
      ),
    },
    "Clear completed",
  ) as HTMLButtonElement;

  const footer = h("div", { class: "mt-3 flex items-center justify-between" }, status, clearButton);

  const heading = h(
    "div",
    { class: "mb-4 flex items-baseline justify-between" },
    h("h2", { class: "font-display text-xl font-medium text-content-primary" }, "Todos"),
    h("span", { class: "text-xs text-content-tertiary" }, "local-first · multi-tab"),
  );

  const card = h(
    "section",
    {
      class: cx(
        "w-full max-w-md rounded-lg border bg-background-secondary p-6 text-sm",
        "text-content-primary",
      ),
    },
    heading,
    inputForm,
    errorLine,
    list,
    footer,
  );

  const submit = async (): Promise<void> => {
    const value = input.value.trim();
    if (!value) return;
    input.value = "";
    clearMutationError(errorLine);
    try {
      await client.mutation(api.todos.add, { text: value }, { optimisticUpdate: optimisticAdd });
    } catch (error) {
      console.error("add failed", error);
      showMutationError(errorLine, error);
    } finally {
      input.focus();
    }
  };

  inputForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void submit();
  });

  clearButton.addEventListener("click", () => {
    clearMutationError(errorLine);
    void client
      .mutation(api.todos.clearCompleted, {}, { optimisticUpdate: optimisticClearCompleted })
      .catch((error) => {
        console.error("clearCompleted failed", error);
        showMutationError(errorLine, error);
      });
  });

  watch<Todo[]>(api.todos.list, {}, (handle) => {
    if (handle.error) {
      clearButton.disabled = true;
      status.textContent = "error";
      status.className = "text-xs text-content-error";
      clear(list);
      list.append(
        h(
          "li",
          { class: "py-3 text-center text-sm text-content-error" },
          errorMessage(handle.error),
        ),
      );
      return;
    }
    if (handle.current === undefined) {
      status.className = "text-xs text-content-secondary tabular-nums";
      status.textContent = "";
      clearButton.disabled = true;
      clearButton.className = cx(
        "cursor-not-allowed rounded-md px-2 py-1 text-xs text-content-tertiary",
        "transition-colors",
      );
      renderLoading(list);
      return;
    }
    const todos = handle.current;
    const remaining = todos.filter((t) => !t.done).length;
    const completed = todos.length - remaining;
    status.className = "text-xs text-content-secondary tabular-nums";
    status.textContent = formatRemaining(remaining, todos.length);
    clearButton.disabled = completed === 0;
    clearButton.className = cx(
      "rounded-md px-2 py-1 text-xs transition-colors",
      completed === 0
        ? "cursor-not-allowed text-content-tertiary"
        : "text-content-secondary hover:bg-background-tertiary hover:text-content-primary",
    );
    renderList(list, todos);
  });

  return card;
}

function renderLoading(container: HTMLElement): void {
  clear(container);
  container.append(
    h("li", { class: "py-8 text-center text-sm text-content-secondary" }, "Loading..."),
  );
}

function renderList(container: HTMLElement, todos: Todo[]): void {
  clear(container);
  if (todos.length === 0) {
    container.append(
      h("li", { class: "py-8 text-center text-sm text-content-secondary" }, "No todos yet"),
    );
    return;
  }
  for (const todo of todos) container.append(renderRow(todo));
}

function renderRow(todo: Todo): HTMLElement {
  const checkbox = h("input", {
    type: "checkbox",
    "aria-label": todo.done ? "Mark as not done" : "Mark as done",
    class: cx(
      "form-checkbox size-3.5 shrink-0 rounded-sm bg-background-secondary text-util-accent",
      "checked:bg-util-accent enabled:cursor-pointer enabled:hover:outline",
      "enabled:hover:outline-content-primary",
      "focus:ring-0 focus:ring-offset-0 focus:outline-none",
      "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border-selected",
      "focus-visible:outline-solid",
    ),
  }) as HTMLInputElement;
  checkbox.checked = todo.done;

  const label = h(
    "span",
    {
      class: cx(
        "min-w-0 grow truncate text-sm",
        todo.done ? "text-content-tertiary line-through" : "text-content-primary",
      ),
    },
    todo.text,
  );

  const removeButton = h(
    "button",
    {
      type: "button",
      "aria-label": "Delete todo",
      class: cx(
        "inline-flex shrink-0 items-center justify-center rounded-md p-1",
        "text-content-tertiary opacity-0 transition-opacity",
        "group-hover:opacity-100 group-focus-within:opacity-100",
        "hover:text-content-primary",
      ),
    },
    xIcon(),
  );

  const row = h(
    "li",
    {
      class: cx("group flex items-center gap-3 border-t py-2 first:border-t-0"),
    },
    checkbox,
    label,
    removeButton,
  );

  checkbox.addEventListener("change", () => {
    void client
      .mutation(api.todos.toggle, { id: todo._id }, { optimisticUpdate: optimisticToggle })
      .catch((error) => {
        console.error("toggle failed", error);
      });
  });
  removeButton.addEventListener("click", () => {
    void client
      .mutation(api.todos.remove, { id: todo._id }, { optimisticUpdate: optimisticRemove })
      .catch((error) => {
        console.error("remove failed", error);
      });
  });

  return row;
}

let optimisticTodoId = 0;

const optimisticAdd = (localStore: OptimisticLocalStore, args: { text: string }): void => {
  const todos = localStore.getQuery(api.todos.list, {}) as Todo[] | undefined;
  if (!todos) return;
  optimisticTodoId += 1;
  localStore.setQuery(api.todos.list, {}, [
    {
      _creationTime: Date.now(),
      _id: `optimistic:${optimisticTodoId}` as Id<"todos">,
      done: false,
      text: args.text.trim(),
    },
    ...todos,
  ]);
};

const optimisticToggle = (localStore: OptimisticLocalStore, args: { id: Id<"todos"> }): void => {
  const todos = localStore.getQuery(api.todos.list, {}) as Todo[] | undefined;
  if (!todos) return;
  localStore.setQuery(
    api.todos.list,
    {},
    todos.map((todo) => (todo._id === args.id ? { ...todo, done: !todo.done } : todo)),
  );
};

const optimisticRemove = (localStore: OptimisticLocalStore, args: { id: Id<"todos"> }): void => {
  const todos = localStore.getQuery(api.todos.list, {}) as Todo[] | undefined;
  if (!todos) return;
  localStore.setQuery(
    api.todos.list,
    {},
    todos.filter((todo) => todo._id !== args.id),
  );
};

const optimisticClearCompleted = (localStore: OptimisticLocalStore): void => {
  const todos = localStore.getQuery(api.todos.list, {}) as Todo[] | undefined;
  if (!todos) return;
  localStore.setQuery(
    api.todos.list,
    {},
    todos.filter((todo) => !todo.done),
  );
};

function showMutationError(container: HTMLElement, error: unknown): void {
  container.textContent = errorMessage(error);
  container.className = "mb-3 text-sm text-content-error";
}

function clearMutationError(container: HTMLElement): void {
  container.textContent = "";
  container.className = "mb-3 hidden text-sm text-content-error";
}

function formatRemaining(remaining: number, total: number): string {
  if (total === 0) return "";
  if (remaining === 0) return `${total} done`;
  return `${remaining} of ${total} remaining`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return "unknown error";
  }
}

function xIcon(): SVGElement {
  return svg(
    "svg",
    {
      viewBox: "0 0 12 12",
      width: "12",
      height: "12",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "1.5",
      "stroke-linecap": "round",
    },
    svg("path", { d: "M3 3l6 6M9 3l-6 6" }),
  );
}
