import { DataviewApi } from 'obsidian-dataview'
import {EditorView} from '@codemirror/view'

export interface ObsidianCommandInterface {
    executeCommandById(id: string): void
    // commands: {
    //     'editor:save-file': {
    //         callback(): void
    //     }
    // }
    // listCommands(): Command[]
}
  
declare module 'obsidian' {
    interface App {
        plugins: {
            enabledPlugins: Set<string>
            plugins: {
                [id: string]: unknown
                dataview?: {
                    api?: DataviewApi
                    manifest: {
                        version: string
                    }
                }
            }
            getPlugin(pluginId: string): Plugin | undefined
        }
        internalPlugins: {
            enablePlugin(name: string): Promise<void>
            disablePlugin(name: string): Promise<void>
            plugins: {
                graph: {
                    enabled: boolean
                    loadData(): Promise<any>
                    load(): void
                    unload(): void
                }
            }
        }
        commands: {
            commands: {
                [id:string]: {
                    callback: () => void
                }
            }
            removeCommand: (commandName: string) => void
        }
    }
    interface DataAdapter {
        basePath: string
    }
    interface Editor {
        cm?: EditorView
    }
}
