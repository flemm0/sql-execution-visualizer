import type { ReactNode } from 'react'
import { Group, Panel, useDefaultLayout } from 'react-resizable-panels'
import { settingsStorage } from '../storage'
import { Pane, ResizeHandle } from './Pane'

interface WorkspaceProps {
  schemaBrowser: ReactNode
  editor: ReactNode
  editorToolbar: ReactNode
  plan: ReactNode
  visualization: ReactNode
  results: ReactNode
}

/**
 * The five panes (docs/UX.md#layout): the schema browser on the left; the
 * editor and plan on top; the visualization in the middle; results at the
 * bottom. Three nested groups do the arranging, and each one saves its sizes
 * in this browser so the layout survives a reload.
 */
export function Workspace(props: WorkspaceProps) {
  const columns = useDefaultLayout({ id: 'layout-columns', storage: settingsStorage })
  const rows = useDefaultLayout({ id: 'layout-rows', storage: settingsStorage })
  const top = useDefaultLayout({ id: 'layout-top', storage: settingsStorage })

  return (
    <Group
      id="layout-columns"
      orientation="horizontal"
      defaultLayout={columns.defaultLayout}
      onLayoutChanged={columns.onLayoutChanged}
    >
      <Pane id="schema-pane" title="Schema" collapseToward="left" defaultSize="20" minSize={200}>
        {props.schemaBrowser}
      </Pane>
      <ResizeHandle between="columns" />
      <Panel id="main-area" minSize={400}>
        <Group id="layout-rows" orientation="vertical" defaultLayout={rows.defaultLayout} onLayoutChanged={rows.onLayoutChanged}>
          <Panel id="top-area" defaultSize="35" minSize={120}>
            <Group id="layout-top" orientation="horizontal" defaultLayout={top.defaultLayout} onLayoutChanged={top.onLayoutChanged}>
              <Pane
                id="editor-pane"
                title="SQL editor"
                collapseToward="left"
                defaultSize="55"
                minSize={240}
                toolbar={props.editorToolbar}
              >
                {props.editor}
              </Pane>
              <ResizeHandle between="columns" />
              <Pane id="plan-pane" title="Execution plan" collapseToward="right" defaultSize="45" minSize={200}>
                {props.plan}
              </Pane>
            </Group>
          </Panel>
          <ResizeHandle between="rows" />
          <Pane id="visualization-pane" title="Visualization" collapseToward="up" defaultSize="40" minSize={120}>
            {props.visualization}
          </Pane>
          <ResizeHandle between="rows" />
          <Pane id="results-pane" title="Results" collapseToward="down" defaultSize="25" minSize={80}>
            {props.results}
          </Pane>
        </Group>
      </Panel>
    </Group>
  )
}
