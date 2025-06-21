import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
import { exec,spawn } from 'child_process';
import { FileSystemAdapter } from 'obsidian';
import * as fs from 'fs';
import * as path from 'path';
import { error } from 'console';
// Remember to rename these classes and interfaces!

interface MyPluginSettings {
	sshHost: string;
	sshPassword: string;
	imageFolder: string;
}


const DEFAULT_SETTINGS: MyPluginSettings = {
	sshHost: '10.11.99.1',
	sshPassword: '',
	imageFolder: 'attachments'
};

export default class RemarkableScreenshotPlugin extends Plugin {
	settings: MyPluginSettings;

	async onload() {
		await this.loadSettings();

				this.registerEvent(
		this.app.workspace.on('editor-menu', (menu, editor, view) => {
			menu.addItem((item) => {
			item.setTitle('Insert Screenshot')
				.setIcon('camera')
				.onClick(() => {
				checkRemarkable(this.settings.sshHost, this);
				});
			});
		})
		);
		this.addCommand({
			id: 'insert-remarkable-screenshot',
			name: 'insert-remarkable-screenshot',
			callback: () => {
				checkRemarkable(this.settings.sshHost, this);			}
		});

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new RemarkableSettingsTab(this.app, this));

		// If the plugin hooks up any global DOM events (on parts of the app that doesn't belong to this plugin)
		// Using this function will automatically remove the event listener when this plugin is disabled.
		this.registerDomEvent(document, 'click', (evt: MouseEvent) => {
			console.log('click', evt);
		});

		// When registering intervals, this function will automatically clear the interval when the plugin is disabled.
		this.registerInterval(window.setInterval(() => console.log('setInterval'), 5 * 60 * 1000));
	}

	onunload() {

	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	insertScreenshot() {
		const adapter = this.app.vault.adapter;
	
		// Narrow the type explicitly
		if (!(adapter instanceof FileSystemAdapter)) {
			new Notice("This plugin only works with a local vault.");
			return;
		}
		// gets the absolute path of the vault 
		const fsAdapter = adapter as FileSystemAdapter;
		const vaultPath = fsAdapter.getBasePath();
	
		captureScreenshot(vaultPath, this.settings)
		.then((filename) => {
			const imagePath = `![[${filename}]]`;
			const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
	
			if (markdownView?.editor) {
				markdownView.editor.replaceSelection(imagePath);
				new Notice(`Inserted screenshot: ${filename}`);
			} else {
				new Notice("No active markdown editor.");
			}
		})
		.catch((err) => {
			console.error("Screenshot failed:", err);
			new Notice(`Screenshot failed: ${err.message}`);
		});
	}
	
	async saveSettings() {
		await this.saveData(this.settings);
	}
}

// this checks if the remarkable is reachable on the network
function checkRemarkable(ip: string, plugin: RemarkableScreenshotPlugin): void {
	exec(`ping -c 1 ${ip}`, (error) => {
		if (!error) {
			plugin.insertScreenshot();
		} else {
			new Notice('Device not reachable');
		}
	});
}


async function captureScreenshot(vaultPath: string, settings: MyPluginSettings): Promise<string> {
	return new Promise((resolve, reject) => {
		const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
		const filename = `remarkable-${timestamp}.png`;
		const attachmentsDir = path.join(vaultPath, settings.imageFolder);
		const outputPath = path.join(attachmentsDir, filename);
		
		if (!fs.existsSync(attachmentsDir)) {
			fs.mkdirSync(attachmentsDir, { recursive: true });
		}
		
		const ssh = spawn('sshpass', [
			'-e',
			'ssh',
			`root@${settings.sshHost}`,
			'cat /dev/fb0'
		], {
			env: {
				...process.env,
				SSHPASS: settings.sshPassword
			}
		});
		
		const head = spawn('head', ['-c', '5271552']);
		const convert = spawn('convert', [
			'-size', '1408x1872',
			'-depth', '16',
			'gray:-',
			'-crop', '1404x1872+0+0',
			'+repage',
			outputPath
		]);
		
		// Pipe ssh -> head -> convert
		ssh.stdout.pipe(head.stdin);
		head.stdout.pipe(convert.stdin);

		// Clean shutdown
		head.on('close', () => {
			if (!ssh.killed) ssh.kill();
		});

		// Handle EPIPE (expected) only
		ssh.stdout.on('error', (err: any) => {
			if (err.code !== 'EPIPE') {
				console.error('ssh.stdout error:', err);
			}
		});

		head.stdin.on('error', (err: any) => {
			if (err.code !== 'EPIPE') {
				console.error('head.stdin error:', err);
			}
		});

		// Debug ImageMagick output
		convert.stderr.on('data', (data) => {
			console.error("CONVERT STDERR:", data.toString());
		});

		convert.on('error', err => {
			reject(new Error(`ImageMagick failed: ${err.message}`));
		});

		convert.on('close', (code) => {
			if (code === 0) {
				resolve(`attachments/${filename}`);
			} else {
				reject(new Error(`convert exited with code ${code}`));
			}
		});

	});
}

class RemarkableSettingsTab extends PluginSettingTab {
	plugin: RemarkableScreenshotPlugin;

	constructor(app: App, plugin: RemarkableScreenshotPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('reMarkable IP')
			.setDesc('The IP address of your reMarkable tablet (default: 10.11.99.1)')
			.addText(text => text
				.setPlaceholder('10.11.99.1')
				.setValue(this.plugin.settings.sshHost)
				.onChange(async (value) => {
					this.plugin.settings.sshHost = value.trim();
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('SSH Password')
			.setDesc('Password for SSH connection to reMarkable (use SSH key if possible)')
			.addText(text => text
				.setPlaceholder('Leave blank if using key')
				.setValue(this.plugin.settings.sshPassword)
				.onChange(async (value) => {
					this.plugin.settings.sshPassword = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Image Folder')
			.setDesc('Vault-relative folder to save screenshots (e.g., attachments, screenshots)')
			.addText(text => text
				.setPlaceholder('attachments')
				.setValue(this.plugin.settings.imageFolder)
				.onChange(async (value) => {
					this.plugin.settings.imageFolder = value.trim() || 'attachments';
					await this.plugin.saveSettings();
				}));
	}
}
