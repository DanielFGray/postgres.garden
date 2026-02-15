/**
 * Workspace templates for default playgrounds
 * Can be used by both server (SSR) and client
 */

export interface WorkspaceEditorLayout {
  uri: string;
  viewColumn: number;
}

export interface WorkspaceLayout {
  editors: {
    orientation: number;
    groups: Array<{ size: number }>;
  };
}

export interface WorkspaceTemplate {
  defaultLayout: {
    editors: WorkspaceEditorLayout[];
    layout: WorkspaceLayout;
  };
  files: Record<string, string>;
}

/**
 * Small example workspace - loads by default on home page
 */
export function getSmallExampleWorkspace(): WorkspaceTemplate {
  return {
    defaultLayout: {
      editors: [
        {
          uri: "/workspace/example.md",
          viewColumn: 1,
        },
      ],
      layout: {
        editors: {
          orientation: 0,
          groups: [{ size: 1 }],
        },
      },
    },
    files: {
      "/workspace/example.md": `
# Welcome to postgres.garden!

Click the \`Run All\` button above to execute all cells in this notebook.

\`\`\`sql
select version();
\`\`\`

\`\`\`sql
drop table if exists nums cascade;
\`\`\`

\`\`\`sql
create table nums as
  select
    gen_random_uuid() as id,
    num
  from
    generate_series(1000, 10000) as num;
\`\`\`

\`\`\`sql
alter table nums add primary key(id);
create index on nums ((num % 2000));
analyze;
\`\`\`

hint: use \`Ctrl+/\` to toggle comments on the current line

\`\`\`sql
-- explain (analyze, costs, verbose, buffers, format json)
select * from nums where (num % 2000) = 0;
\`\`\``,
    },
  };
}
