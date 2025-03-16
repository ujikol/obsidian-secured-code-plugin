import { App, Plugin, PluginSettingTab, Setting, MarkdownPostProcessorContext, MarkdownRenderer, Notice, TFile, debounce } from 'obsidian';
import { getAPI, DataviewApi } from "obsidian-dataview"
import * as crypto from 'crypto';

interface SecuredCodeSettings {
    trustedHashesNotes: string[];
    trustedHashes: string[];
    allowUntrustedCode: boolean;
    bypassDataviewJsSecurity: boolean;
    bypassMetaBindButtonSecurity: boolean;
}

const DEFAULT_SETTINGS: SecuredCodeSettings = {
    trustedHashesNotes: [],
    trustedHashes: [],
    allowUntrustedCode: false,
    bypassDataviewJsSecurity: false,
    bypassMetaBindButtonSecurity: false
}


export default class SecuredCodePlugin extends Plugin {
    settings: SecuredCodeSettings;
    allTrustedHashes: string[] = [];
	dv: DataviewApi
    originalExecuteJs: any = null;
    mb: Plugin
    originalJsEngineRunCode: any = null;

    async onload() {
        await this.loadSettings();
        this.addSettingTab(new SecuredCodeSettingTab(this.app, this))
        
        // Load trusted hashes when the layout is ready
        this.app.workspace.onLayoutReady(async () => {
            this.loadTrustedHashes()
            this.getDataviewAndPatch()
            this.getMetaBindAndPatch()
        })
        
        // Monitor for changes to trusted hash files
        this.registerEvent(
            this.app.metadataCache.on('changed', this.onFileChanged.bind(this))
        )
    }
    
	async getDataviewAndPatch(trynumber:number=1) {
		const dv = getAPI(this.app)
		if (dv) {
			this.dv = dv
            this.monkeyPatchExecuteJs()
			return
		}
		if (trynumber >= 10)
			throw ("Error: dataview not secured.")
		await new Promise(f => setTimeout(f, 100*2^trynumber))
		this.getDataviewAndPatch(++trynumber)
	}
    
	async getMetaBindAndPatch(trynumber:number=1) {
		const mb = this.app.plugins.getPlugin("obsidian-meta-bind-plugin")
		if (mb) {
			this.mb = mb
            this.monkeyPatchJsEngine()
			return
		}
		if (trynumber >= 10)
			throw ("Error: meta-bind not secured.")
		await new Promise(f => setTimeout(f, 100*2^trynumber))
		this.getMetaBindAndPatch(++trynumber)
	}
    
    monkeyPatchExecuteJs() {
        this.originalExecuteJs = this.dv.executeJs
        this.dv.executeJs = this.securedExecuteJs
        console.log('SecuredCode: Monkey patched executeJs.')
    }
    
    securedExecuteJs(code: string, container: HTMLElement, component: any | MarkdownPostProcessorContext, filePath: string) {
        const self = (this.app.plugins.getPlugin("secured-code") as SecuredCodePlugin)
        const hash = self.calculateHash(code)
        const allowExecution = self.allTrustedHashes.includes(hash) || self.settings.allowUntrustedCode || self.settings.bypassDataviewJsSecurity
        
        if (allowExecution) {
            const that = this as DataviewApi
            that.executeJs = self.originalExecuteJs
            const res = that.executeJs(code, container, component, filePath)
            that.executeJs = self.securedExecuteJs
            return res
        } else {
            console.warn('SecuredCode: Blocked untrusted dataviewjs execution. Hash:', hash)
            self.renderSecurityError(component.el, hash, "datavierjs")
        }
    }
    
    monkeyPatchJsEngine() {
        // @ts-ignore - Access to private API
        this.originalJsEngineRunCode = this.mb.internal.jsEngineRunCode
        // @ts-ignore - Access to private API
        this.mb.internal.jsEngineRunCode = this.securedJsEngineRunCode
        // @ts-ignore - Access to private API
        this.originalJsEngineRunFile = this.mb.internal.jsEngineRunFile
        // @ts-ignore - Access to private API
        this.mb.internal.jsEngineRunFile = this.securedJsEngineRunFile
        console.log('SecuredCode: Monkey patched JS Engine.')
    }
    
    async securedJsEngineRunCode(code: string, callingFilePath: string, contextOverrides: Record<string, unknown>, container?: HTMLElement): Promise<void> {
        const self = (this.app.plugins.getPlugin("secured-code") as SecuredCodePlugin)
        const hash = self.calculateHash(code)
        const allowExecution = self.allTrustedHashes.includes(hash) || self.settings.allowUntrustedCode || self.settings.bypassMetaBindButtonSecurity
        
        if (!allowExecution)
            code = `console.log("SecuredCode: Blocked untrusted meta-bind execution. Hash: ${hash}")`
        const that = this as any
        that.jsEngineRunCode = self.originalJsEngineRunCode
        const res = await that.jsEngineRunCode(code, callingFilePath, contextOverrides, container)
        that.jsEngineRunCode = self.securedJsEngineRunCode
        return res
	}
    
    async securedJsEngineRunFile(filePath: string, callingFilePath: string, contextOverrides: Record<string, unknown>, container?: HTMLElement): Promise<void> {
        const self = (this.app.plugins.getPlugin("secured-code") as SecuredCodePlugin)
        const file = this.app.vault.getFileByPath(filePath)
        if (!file) {
            console.error('SecuredCode: File not found:', filePath)
            return
        }
        let code = await this.app.vault.cachedRead(file)
        const hash = self.calculateHash(code)
        const allowExecution = self.allTrustedHashes.includes(hash) || self.settings.allowUntrustedCode || self.settings.bypassMetaBindButtonSecurity
        
        if (!allowExecution)
            code = `console.log("SecuredCode: Blocked untrusted meta-bind execution. Hash: ${hash}")`
        const that = this as any
        that.jsEngineRunCode = self.originalJsEngineRunCode
        const res = await that.jsEngineRunCode(code, callingFilePath, contextOverrides, container)
        that.jsEngineRunCode = self.securedJsEngineRunCode
        return res
	}
    
    onunload() {
        // Restore original eval and Function when plugin is disabled
        if (this.originalExecuteJs) {
            this.dv.executeJs = this.originalExecuteJs
            console.log('SecuredCode: Restored unsecured dataviewjs.')
        }
        if (this.originalJsEngineRunCode) {
            // @ts-ignore - Access to private API
            this.mb.internal.jsEngineRunCode = this.originalJsEngineRunCode
            console.log('SecuredCode: Restored unsecured meta-bind.')
        }
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    // Debounced file change handler
    onFileChanged = debounce((file) => {
        // If the file is one of our trusted hash files, reload the hashes
        const filePath = (file as TFile).path.replace(/\.md$/, '');
        if (this.settings.trustedHashesNotes.includes(filePath)) {
            this.loadTrustedHashes();
        }
    }, 1000, true);

    // Force refresh of all markdown previews
    refreshAllMarkdownPreviews() {
        this.app.workspace.iterateAllLeaves(leaf => {
            // @ts-ignore - Access to private API
            const view = leaf.view;
            if (view && view.getViewType() === 'markdown') {
                // @ts-ignore - Access to private API
                if (view.previewMode) {
                    // @ts-ignore - Access to private API
                    view.previewMode.rerender(true);
                }
            }
        });
    }

    async loadTrustedHashes() {
        const trustedHashes = [...this.settings.trustedHashes];

        // Load trusted hashes from  notes
        for (const notePath of this.settings.trustedHashesNotes) {
            try {
                const file = this.app.vault.getFileByPath(notePath + ".md");
                if (file && file.path) {
                    const content = await this.app.vault.read(file);
                    const lines = content.split('\n').filter(line => !line.startsWith('#'))
                    for (const line of lines) {
                        const hash = line.trim();
                        if (hash && !trustedHashes.includes(hash)) {
                            trustedHashes.push(hash);
                        }
                    }
                }
            } catch (error) {
                console.error(`Failed to load trusted hashes from note ${notePath}:`, error);
            }
        }

        // Update the trusted hashes in memory
        this.allTrustedHashes = trustedHashes;
        // Refresh all markdown previews to apply the new hash list
        this.refreshAllMarkdownPreviews();
    }

    calculateHash(content: string): string {
        return crypto.createHash('sha256').update(content).digest('hex');
    }

    // Render an error message for untrusted code
    renderSecurityError(el: HTMLElement, hash: string, language: string) {
        const errorEl = el.createEl('div', { cls: 'secured-code-error' });
        errorEl.createEl('h3', { text: `Untrusted ${language} Code` });
        errorEl.createEl('p', { text: 'This code block hash does not match any trusted hash.' });
        errorEl.createEl('p', { text: `Hash: ${hash}` });
        
        // Add a button to copy the hash for easy addition to trusted list
        const copyButton = errorEl.createEl('button', { text: 'Copy Hash' });
        copyButton.addEventListener('click', () => {
            navigator.clipboard.writeText(hash);
            copyButton.setText('Copied!');
            setTimeout(() => {
                copyButton.setText('Copy Hash');
            }, 2000);
        });
    }

}

class SecuredCodeSettingTab extends PluginSettingTab {
    plugin: SecuredCodePlugin;

    constructor(app: App, plugin: SecuredCodePlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'Secured Code Settings' });
        // Global Security Settings
        containerEl.createEl('h3', { text: 'Security Settings' });
        new Setting(containerEl)
            .setName('Allow Untrusted Code')
            .setDesc('If enabled, all code blocks will be executed regardless of trust status (not recommended)')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.allowUntrustedCode)
                .onChange(async (value) => {
                    this.plugin.settings.allowUntrustedCode = value;
                    await this.plugin.saveSettings();
                    this.plugin.refreshAllMarkdownPreviews();
                }));
        new Setting(containerEl)
            .setName('Bypass DataviewJS Security')
            .setDesc('If enabled, all dataviewjs code blocks will be executed regardless of trust status')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.bypassDataviewJsSecurity)
                .onChange(async (value) => {
                    this.plugin.settings.bypassDataviewJsSecurity = value;
                    await this.plugin.saveSettings();
                    this.plugin.refreshAllMarkdownPreviews();
                }));
        new Setting(containerEl)
            .setName('Bypass Meta Bind Button Security')
            .setDesc('If enabled, all meta-bind-button code blocks will be executed regardless of trust status')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.bypassMetaBindButtonSecurity)
                .onChange(async (value) => {
                    this.plugin.settings.bypassMetaBindButtonSecurity = value;
                    await this.plugin.saveSettings();
                    this.plugin.refreshAllMarkdownPreviews();
                }));

        containerEl.createEl('h3', { text: 'Trusted Notes' });
        containerEl.createEl('p', {
            text: 'List of notes in your vault that contain trusted hashes (one hash per line).'
        });

        new Setting(containerEl)
            .setName('Add Trusted Note')
            .setDesc('Enter the path to a note containing trusted hashes')
            .addText(text => text
                .setPlaceholder('path/to/trusted-hashes')
                .onChange(async (value) => {
                    // Don't save until the Add button is clicked
                }))
            .addButton(button => button
                .setButtonText('Add')
                .onClick(async () => {
                    const inputEl = button.buttonEl.parentElement?.querySelector('input');
                    if (inputEl && inputEl.value) {
                        const notePath = inputEl.value;
                        if (!this.plugin.settings.trustedHashesNotes.includes(notePath)) {
                            this.plugin.settings.trustedHashesNotes.push(notePath);
                            await this.plugin.saveSettings();
                            await this.plugin.loadTrustedHashes();
                            this.display(); // Refresh the settings panel
                        }
                        inputEl.value = '';
                    }
                }));

        // Display current trusted notes with delete buttons
        this.plugin.settings.trustedHashesNotes.forEach((notePath, index) => {
            new Setting(containerEl)
                .setName(notePath)
                .addButton(button => button
                    .setButtonText('Remove')
                    .onClick(async () => {
                        this.plugin.settings.trustedHashesNotes.splice(index, 1);
                        await this.plugin.saveSettings();
                        await this.plugin.loadTrustedHashes();
                        this.display(); // Refresh the settings panel
                    }));
        });

        containerEl.createEl('h3', { text: 'Trusted External Files' });
        containerEl.createEl('p', {
            text: 'List of external files that contain trusted hashes (one hash per line).'
        });

        containerEl.createEl('h3', { text: 'Manually Trusted Hashes' });
        containerEl.createEl('p', {
            text: 'You can also directly add trusted hashes here.'
        });

        new Setting(containerEl)
            .setName('Add Trusted Hash')
            .setDesc('Enter a hash to trust')
            .addText(text => text
                .setPlaceholder('e.g., 7d1a54127b222502f5b79b5fb0803061152a44f92b37e23c6527baf665d4da9a')
                .onChange(async (value) => {
                    // Don't save until the Add button is clicked
                }))
            .addButton(button => button
                .setButtonText('Add')
                .onClick(async () => {
                    const inputEl = button.buttonEl.parentElement?.querySelector('input');
                    if (inputEl && inputEl.value) {
                        const hash = inputEl.value.trim();
                        if (!this.plugin.settings.trustedHashes.includes(hash)) {
                            this.plugin.settings.trustedHashes.push(hash);
                            await this.plugin.saveSettings();
                            await this.plugin.loadTrustedHashes();
                            this.display(); // Refresh the settings panel
                        }
                        inputEl.value = '';
                    }
                }));

        // Display current manual trusted hashes with delete buttons
        this.plugin.settings.trustedHashes.forEach((hash, index) => {
            new Setting(containerEl)
                .setName(hash)
                .addButton(button => button
                    .setButtonText('Remove')
                    .onClick(async () => {
                        this.plugin.settings.trustedHashes.splice(index, 1);
                        await this.plugin.saveSettings();
                        await this.plugin.loadTrustedHashes();
                        this.display(); // Refresh the settings panel
                    }));
        });

        // Add buttons to reload trusted hashes and refresh previews
        containerEl.createEl('h3', { text: 'Actions' });
        new Setting(containerEl)
            .setName('Reload Trusted Hashes')
            .setDesc('Reload all trusted hashes from notes')
            .addButton(button => button
                .setButtonText('Reload')
                .onClick(async () => {
                    await this.plugin.loadTrustedHashes();
                    new Notice('Trusted hashes reloaded successfully!');
                }));
        new Setting(containerEl)
            .setName('Refresh Previews')
            .setDesc('Force refresh all markdown previews to apply security settings')
            .addButton(button => button
                .setButtonText('Refresh')
                .onClick(async () => {
                    this.plugin.refreshAllMarkdownPreviews();
                    new Notice('Previews refreshed successfully!');
                }));
    }
}