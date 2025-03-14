import { App, Plugin, PluginSettingTab, Setting, MarkdownPostProcessorContext, MarkdownRenderer, Notice } from 'obsidian';
import * as crypto from 'crypto';

interface SecureJsSettings {
	trustedHashesNotes: string[];
	trustedExternalFiles: string[];
	trustedHashes: string[];
}

const DEFAULT_SETTINGS: SecureJsSettings = {
	trustedHashesNotes: [],
	trustedExternalFiles: [],
	trustedHashes: []
}

export default class SecureJsPlugin extends Plugin {
	settings: SecureJsSettings;
    allTrustedHashes: string[] = [];

	async onload() {
		await this.loadSettings();
		this.registerMarkdownCodeBlockProcessor('secure-dataviewjs', this.processSecureDataviewJsBlock.bind(this));
		this.registerMarkdownCodeBlockProcessor('secure-meta-bind-button', this.processSecureMetaBindButtonBlock.bind(this));
		this.addSettingTab(new SecureJsSettingTab(this.app, this));
		this.app.workspace.onLayoutReady(() => this.loadTrustedHashes());
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async loadTrustedHashes() {
		const trustedHashes = [...this.settings.trustedHashes];

		// Load hashes from trusted notes
		for (const notePath of this.settings.trustedHashesNotes) {
			try {
				const file = this.app.vault.getFileByPath(notePath + ".md");
                console.log('File:', notePath, file);
				if (file && file.path) {
					const content = await this.app.vault.read(file);
					const lines = content.split('\n');
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

		// Load hashes from external files
		for (const filePath of this.settings.trustedExternalFiles) {
			try {
				const response = await fetch(`file://${filePath}`);
				if (response.ok) {
					const text = await response.text();
					const lines = text.split('\n');
					for (const line of lines) {
						const hash = line.trim();
						if (hash && !trustedHashes.includes(hash)) {
							trustedHashes.push(hash);
						}
					}
				}
			} catch (error) {
				console.error(`Failed to load trusted hashes from external file ${filePath}:`, error);
			}
		}

		// Update the trusted hashes in memory (not persisted to settings)
		this.allTrustedHashes = trustedHashes;
	}

	calculateHash(content: string): string {
		return crypto.createHash('sha256').update(content).digest('hex');
	}

	async processSecureDataviewJsBlock(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) {
        this.processSecureJsBlock('dataviewjs', source, el, ctx)
    }

	async processSecureMetaBindButtonBlock(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) {
        this.processSecureJsBlock('meta-bind-button', source, el, ctx)
    }

    async processSecureJsBlock(type: string, source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) {
		const hash = this.calculateHash(source);
		
		if (this.allTrustedHashes.includes(hash)) {
			// if (this.app.plugins.getPlugin('dataview')) {
                const block = `\`\`\`${type}\n${source}\n\`\`\``
				await MarkdownRenderer.render(this.app, block, el, ctx.sourcePath, this);
			// } else {
			// 	el.createEl('div', {
			// 		cls: 'secure-js-error',
			// 		text: 'Error: Dataview plugin is required but not enabled.'
			// 	});
			// }
		} else {
			// Hash is not trusted, show error message
			const errorEl = el.createEl('div', { cls: 'secure-js-error' });
			errorEl.createEl('h3', { text: 'Untrusted DataviewJS Code' });
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
}

class SecureJsSettingTab extends PluginSettingTab {
	plugin: SecureJsPlugin;

	constructor(app: App, plugin: SecureJsPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: 'Secure JS Settings' });
		
		containerEl.createEl('h3', { text: 'Trusted Notes' });
		containerEl.createEl('p', { 
			text: 'List of notes in your vault that contain trusted hashes (one hash per line).'
		});

		new Setting(containerEl)
			.setName('Add Trusted Note')
			.setDesc('Enter the path to a note containing trusted hashes')
			.addText(text => text
				.setPlaceholder('path/to/trusted-hashes.md')
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

		new Setting(containerEl)
			.setName('Add External File')
			.setDesc('Enter the path to an external file containing trusted hashes')
			.addText(text => text
				.setPlaceholder('/path/to/trusted-hashes.txt')
				.onChange(async (value) => {
					// Don't save until the Add button is clicked
				}))
			.addButton(button => button
				.setButtonText('Add')
				.onClick(async () => {
					const inputEl = button.buttonEl.parentElement?.querySelector('input');
					if (inputEl && inputEl.value) {
						const filePath = inputEl.value;
						if (!this.plugin.settings.trustedExternalFiles.includes(filePath)) {
							this.plugin.settings.trustedExternalFiles.push(filePath);
							await this.plugin.saveSettings();
							await this.plugin.loadTrustedHashes();
							this.display(); // Refresh the settings panel
						}
						inputEl.value = '';
					}
				}));

		// Display current trusted external files with delete buttons
		this.plugin.settings.trustedExternalFiles.forEach((filePath, index) => {
			new Setting(containerEl)
				.setName(filePath)
				.addButton(button => button
					.setButtonText('Remove')
					.onClick(async () => {
						this.plugin.settings.trustedExternalFiles.splice(index, 1);
						await this.plugin.saveSettings();
						await this.plugin.loadTrustedHashes();
						this.display(); // Refresh the settings panel
					}));
		});

		containerEl.createEl('h3', { text: 'Manual Trusted Hashes' });
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
						this.display(); // Refresh the settings panel
					}));
		});

		// Add a button to reload trusted hashes
		containerEl.createEl('h3', { text: 'Actions' });
		
		new Setting(containerEl)
			.setName('Reload Trusted Hashes')
			.setDesc('Reload all trusted hashes from notes and external files')
			.addButton(button => button
				.setButtonText('Reload')
				.onClick(async () => {
					await this.plugin.loadTrustedHashes();
					new Notice('Trusted hashes reloaded successfully!');
				}));
	}
}
