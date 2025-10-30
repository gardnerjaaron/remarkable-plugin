import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
import { exec, spawn } from 'child_process';
import { FileSystemAdapter } from 'obsidian';
import * as fs from 'fs';
import * as path from 'path';

interface RemarkablePluginSettings {
	sshHost: string;
	sshPassword: string;
	imageFolder: string;
	screenshotTimeout: number;
}

const DEFAULT_SETTINGS: RemarkablePluginSettings = {
	sshHost: '10.11.99.1',
	sshPassword: '',
	imageFolder: 'attachments',
	screenshotTimeout: 30000 // 30 seconds
};

export default class RemarkableScreenshotPlugin extends Plugin {
	settings: RemarkablePluginSettings;

	async onload() {
		await this.loadSettings();

		// Check platform compatibility
		this.checkPlatformCompatibility();

		// Register context menu item
		this.registerEvent(
			this.app.workspace.on('editor-menu', (menu, editor, view) => {
				menu.addItem((item) => {
					item.setTitle('Insert reMarkable Screenshot')
						.setIcon('camera')
						.onClick(() => {
							this.handleScreenshotRequest();
						});
				});
			})
		);

		// Register command
		this.addCommand({
			id: 'insert-remarkable-screenshot',
			name: 'Insert reMarkable Screenshot',
			callback: () => {
				this.handleScreenshotRequest();
			}
		});

		// Add settings tab
		this.addSettingTab(new RemarkableSettingsTab(this.app, this));
	}

	onunload() {
		// Cleanup if needed
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/**
	 * Check if the platform supports the required tools
	 */
	private checkPlatformCompatibility(): void {
		const platform = process.platform;
		
		if (platform === 'win32') {
			console.warn('reMarkable Screenshot Plugin: Windows detected. Requires WSL, Git Bash, or Cygwin with sshpass and ImageMagick installed.');
		}
	}

	/**
	 * Handle screenshot request with device check
	 */
	private handleScreenshotRequest(): void {
		// Validate IP address format
		if (!this.isValidIPAddress(this.settings.sshHost)) {
			new Notice('Invalid IP address format. Please check settings.');
			return;
		}

		// Check if device is reachable
		this.checkDeviceReachability(this.settings.sshHost)
			.then((reachable) => {
				if (reachable) {
					this.insertScreenshot();
				} else {
					new Notice('reMarkable device not reachable. Check IP address and network connection.');
				}
			})
			.catch((err) => {
				console.error('Device check failed:', err);
				new Notice('Failed to check device reachability.');
			});
	}

	/**
	 * Validate IP address format
	 */
	private isValidIPAddress(ip: string): boolean {
		const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
		if (!ipRegex.test(ip)) {
			return false;
		}

		// Check each octet is 0-255
		const octets = ip.split('.');
		return octets.every(octet => {
			const num = parseInt(octet, 10);
			return num >= 0 && num <= 255;
		});
	}

	/**
	 * Check if device is reachable via ping
	 */
	private checkDeviceReachability(ip: string): Promise<boolean> {
		return new Promise((resolve) => {
			// Use platform-appropriate ping command
			const platform = process.platform;
			const pingCmd = platform === 'win32' 
				? `ping -n 1 -w 1000 ${ip}` 
				: `ping -c 1 -W 1 ${ip}`;

			exec(pingCmd, (error) => {
				resolve(!error);
			});
		});
	}

	/**
	 * Capture screenshot from reMarkable and insert into note
	 */
	private insertScreenshot(): void {
		const adapter = this.app.vault.adapter;

		if (!(adapter instanceof FileSystemAdapter)) {
			new Notice("This plugin only works with a local vault.");
			return;
		}

		const vaultPath = adapter.getBasePath();
		const loadingNotice = new Notice('Capturing reMarkable screenshot...', 0);

		this.captureScreenshot(vaultPath)
			.then((filename) => {
				loadingNotice.hide();
				
				const imagePath = `![[${filename}]]`;
				const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);

				if (markdownView?.editor) {
					markdownView.editor.replaceSelection(imagePath);
					new Notice(`Screenshot inserted: ${filename}`);
				} else {
					new Notice("No active markdown editor found.");
				}
			})
			.catch((err) => {
				loadingNotice.hide();
				console.error("Screenshot capture failed:", err);
				new Notice(`Screenshot failed: ${err.message}`);
			});
	}

	/**
	 * Capture screenshot from reMarkable device
	 */
	private async captureScreenshot(vaultPath: string): Promise<string> {
		return new Promise((resolve, reject) => {
			const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
			const filename = `remarkable-${timestamp}.png`;
			const attachmentsDir = path.join(vaultPath, this.settings.imageFolder);
			const outputPath = path.join(attachmentsDir, filename);

			// Ensure attachments directory exists
			if (!fs.existsSync(attachmentsDir)) {
				try {
					fs.mkdirSync(attachmentsDir, { recursive: true });
				} catch (err) {
					reject(new Error(`Failed to create directory: ${err.message}`));
					return;
				}
			}

			let pipelineCompleted = false;
			let processes: any[] = [];

			// Set up SSH connection to capture framebuffer
			const sshArgs = this.settings.sshPassword
				? ['-e', 'ssh', `root@${this.settings.sshHost}`, 'cat /dev/fb0']
				: ['ssh', `root@${this.settings.sshHost}`, 'cat /dev/fb0'];

			const sshCommand = this.settings.sshPassword ? 'sshpass' : 'ssh';
			const sshEnv = this.settings.sshPassword
				? { ...process.env, SSHPASS: this.settings.sshPassword }
				: process.env;

			const ssh = spawn(sshCommand, sshArgs, { env: sshEnv });
			processes.push(ssh);

			// Limit framebuffer data to expected size (reMarkable 2 framebuffer)
			const head = spawn('head', ['-c', '5271552']);
			processes.push(head);

			// Convert raw framebuffer to PNG
			const convert = spawn('convert', [
				'-size', '1408x1872',
				'-depth', '16',
				'gray:-',
				'-crop', '1404x1872+0+0',
				'+repage',
				outputPath
			]);
			processes.push(convert);

			// Set up pipeline: ssh -> head -> convert
			ssh.stdout.pipe(head.stdin);
			head.stdout.pipe(convert.stdin);

			// Clean shutdown when head completes
			head.on('close', () => {
				if (!ssh.killed) {
					ssh.kill();
				}
			});

			// Handle expected EPIPE errors (pipe closing)
			ssh.stdout.on('error', (err: any) => {
				if (err.code !== 'EPIPE') {
					console.error('SSH stdout error:', err);
				}
			});

			head.stdin.on('error', (err: any) => {
				if (err.code !== 'EPIPE') {
					console.error('Head stdin error:', err);
				}
			});

			// Log ImageMagick errors for debugging
			convert.stderr.on('data', (data) => {
				console.error("ImageMagick stderr:", data.toString());
			});

			// Handle process errors
			ssh.on('error', (err) => {
				if (!pipelineCompleted) {
					this.cleanupProcesses(processes);
					reject(new Error(`SSH connection failed: ${err.message}. Ensure sshpass is installed and credentials are correct.`));
				}
			});

			head.on('error', (err) => {
				if (!pipelineCompleted) {
					this.cleanupProcesses(processes);
					reject(new Error(`Head command failed: ${err.message}`));
				}
			});

			convert.on('error', (err) => {
				if (!pipelineCompleted) {
					this.cleanupProcesses(processes);
					reject(new Error(`ImageMagick failed: ${err.message}. Ensure ImageMagick is installed.`));
				}
			});

			// Handle successful completion
			convert.on('close', (code) => {
				pipelineCompleted = true;
				this.cleanupProcesses(processes);

				if (code === 0) {
					resolve(`${this.settings.imageFolder}/${filename}`);
				} else {
					reject(new Error(`ImageMagick exited with code ${code}`));
				}
			});

			// Set timeout for the entire operation
			setTimeout(() => {
				if (!pipelineCompleted) {
					this.cleanupProcesses(processes);
					reject(new Error('Screenshot capture timed out. Check network connection and device status.'));
				}
			}, this.settings.screenshotTimeout);
		});
	}

	/**
	 * Clean up spawned processes
	 */
	private cleanupProcesses(processes: any[]): void {
		processes.forEach(proc => {
			if (proc && !proc.killed) {
				try {
					proc.kill();
				} catch (err) {
					console.error('Error killing process:', err);
				}
			}
		});
	}
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

		containerEl.createEl('h2', { text: 'reMarkable Screenshot Settings' });

		// Security warning for password storage
		if (this.plugin.settings.sshPassword) {
			const warningDiv = containerEl.createDiv('remarkable-security-warning');
			warningDiv.createEl('p', { 
				text: '⚠️ Warning: SSH passwords are stored in plain text. For better security, use SSH key authentication instead.',
				cls: 'mod-warning'
			});
		}

		new Setting(containerEl)
			.setName('reMarkable IP Address')
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
			.setDesc('Password for SSH connection. Leave blank if using SSH key authentication (recommended).')
			.addText(text => {
				text.setPlaceholder('Leave blank if using SSH key')
					.setValue(this.plugin.settings.sshPassword)
					.onChange(async (value) => {
						this.plugin.settings.sshPassword = value;
						await this.plugin.saveSettings();
						this.display(); // Refresh to show/hide warning
					});
				text.inputEl.type = 'password';
				return text;
			});

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

		new Setting(containerEl)
			.setName('Screenshot Timeout')
			.setDesc('Maximum time to wait for screenshot capture (milliseconds)')
			.addText(text => text
				.setPlaceholder('30000')
				.setValue(String(this.plugin.settings.screenshotTimeout))
				.onChange(async (value) => {
					const timeout = parseInt(value, 10);
					if (!isNaN(timeout) && timeout > 0) {
						this.plugin.settings.screenshotTimeout = timeout;
						await this.plugin.saveSettings();
					}
				}));

		// Add documentation section
		containerEl.createEl('h3', { text: 'Setup Instructions' });
		
		const instructionsDiv = containerEl.createDiv();
		instructionsDiv.createEl('p', { text: 'This plugin requires the following tools to be installed:' });
		
		const requirementsList = instructionsDiv.createEl('ul');
		requirementsList.createEl('li', { text: 'SSH access to your reMarkable tablet' });
		requirementsList.createEl('li', { text: 'sshpass (if using password authentication)' });
		requirementsList.createEl('li', { text: 'ImageMagick (convert command)' });
		
		instructionsDiv.createEl('p', { 
			text: 'For SSH key setup, run: ssh-keygen and copy the public key to your reMarkable tablet.'
		});
	}
}