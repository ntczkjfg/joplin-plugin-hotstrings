import joplin from 'api';
import { ContentScriptType, SettingItemType, MenuItemLocation } from 'api/types';

// Stores all current hotkeys and their associated outputs
let hotkeys:    { [key: string] : string } = {};
// Stores all hotkeys that have at some point been defined during this session
// Allows de-activating hotkeys the user removed or changed
let allHotkeys: { [key: string] : string } = {};

joplin.plugins.register({
	onStart: async function() {
		// Create the settings page
		await joplin.settings.registerSection('hotstrings', {
			label: 'Hotstrings',
			description: 'Hotstrings Plugin Settings',
			iconName: 'fas fa-copy',
		});
		await joplin.settings.registerSettings({
			startToken: {
				value: '', // Default start token
				type: SettingItemType.String,
				section: 'hotstrings',
				public: true,
					label: 'Start Token',
			},
			endToken: {
				value: '/', // Default end token
				type: SettingItemType.String,
				section: 'hotstrings',
				public: true,
					label: 'End Token',
			},
			configNoteId: {
				value: '', // ID of the config note for this plugin
				type: SettingItemType.String,
				section: 'hotstrings',
				public: true,
					label: 'Hotstrings definitions note ID',
					description: `Set the note ID for the note you'd like to use for your hotstring definitions. You can auto-populate this field by opening a note, and setting its first line to just "!!!HOTSTRINGS!!!".`
			}
		});
		// Register the editor plugin
		const editorScriptId = 'joplin.plugin.hotstrings.editor';
		await joplin.contentScripts.register(
			ContentScriptType.CodeMirrorPlugin,
			editorScriptId,
			'editorScript.js'
		);
		// The editor script sends messages here to receive and set various settings
		await joplin.contentScripts.onMessage(editorScriptId, async (message: { name: string, data: { [key: string]: any } }) => {
			let configNoteId;
			switch (message.name) {
				case 'getSetting':
					// Returns the value of the specified setting
					return await joplin.settings.value(message.data.id);
				case 'setSetting':
					// Sets the value of the specified setting
					for (const [key, value] of Object.entries(message.data)) {
						await joplin.settings.setValue(key, value);
					}
					break;
				case 'getNoteId':
					// Returns the ID of the currently opened note
					const note = await joplin.workspace.selectedNote();
					return note?.id;
				case 'setHotkeys':
					// Sets the hotkeys and registers them immediately
					hotkeys = message.data.hotkeys;
					updateHotkeys();
					break;
				case 'getDarkMode':
					// Returns if Joplin is using a dark theme or not
					return await joplin.shouldUseDarkColors();
				case 'getConfigNote':
					// Returns the body of the plugin's config note
					configNoteId = await joplin.settings.value('configNoteId');
					try {
						const configNote = await joplin.data.get(['notes', configNoteId], { fields: ['body'] });
						return configNote.body;
					} catch (e) {
						// Error getting the note - ID must be bad, set it to blank
						await joplin.settings.setValue('configNoteId', '');
						return '';
					}
				case 'setConfigNote':
					// Sets the body of the plugin's config note'
					configNoteId = await joplin.settings.value('configNoteId');
					if (!configNoteId) return;
					await joplin.data.put(['notes', configNoteId], null, { body : message.data.content });
					break;
				default:
					break;
			}
		});
	},
});

// Registers user-defined hotkeys
async function updateHotkeys() {
	// Builds a dictionary of only the hotkeys which need updating - either to their new output, or to be 'removed'
	const hotkeysToUpdate = hotkeyHelper();
	if (Object.keys(hotkeysToUpdate).length === 0) return;
	// Build an array of menu items for the submenu we'll make'
	const menuItems = [];
	for (const [hotkey, output] of Object.entries(hotkeysToUpdate)) {
		let name;
		if (output.length > 10) {
			// Don't want to stretch the menu'
			name = "Insert '" + output.slice(0, 7) + '...' + "'";
		} else if (output === '') {
			// I guess we're stretching the menu anyways'
			name = '[defunct Hotstrings plugin hotkey, restart Joplin to remove]'
		} else {
			name = `Insert '${output}'`;
		}
		// It's important the name is deterministic based on the hotkey, rather than random
		// Allows us to overwrite older commands if they've changed in the mean time
		const commandName = `insertText_${hotkey.replace(/\W/g,'_')}`;
		// Register the command:
		await joplin.commands.register({
			name: commandName,
			label: name,
			enabledCondition: 'markdownEditorVisible && !richTextEditorVisible',
			execute: async () => {
				if (output) {
					await joplin.commands.execute('insertText', output.replace(/\\n/g, '\n').replace(/\\t/g, '\t'));
				}
			}
		});
		// Add a menu item that calls our command
		menuItems.push({
			commandName,
			label: name,
			accelerator: hotkey
		});
	}
	// Create a sub-menu, and add all our menu items to it
	await joplin.views.menus.create(
		Math.random().toString(36).slice(2, 12), // Random ID
		'Hotstrings hotkeys', // Label
		menuItems, // Our menu items
		MenuItemLocation.Tools // The menu this is a submenu of
	)
}

// Builds a dictionary of only those hotkeys that actually need changing from their current form
function hotkeyHelper() {
	const hotkeysToUpdate: { [key: string] : string } = {};
	for (const key in hotkeys) {
		if (!(key in allHotkeys)) { // key is novel
			hotkeysToUpdate[key] = hotkeys[key];
			allHotkeys[key] = hotkeys[key];
		} else if (hotkeys[key] !== allHotkeys[key]) { // key exists but value has changed
			hotkeysToUpdate[key] = hotkeys[key];
			allHotkeys[key] = hotkeys[key];
		}
	}
	for (const key in allHotkeys) {
		if (allHotkeys[key] && !(key in hotkeys)) { // key has a value but should not
			hotkeysToUpdate[key] = '';
			allHotkeys[key] = '';
		}
	}
	return hotkeysToUpdate
}
