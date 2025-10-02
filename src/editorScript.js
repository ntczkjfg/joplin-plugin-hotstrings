import { Decoration, ViewPlugin } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import { tutorial, prefill } from './tutorialAndPrefill.js';

export default (context) => {
    return {
        assets: () => [{ name: 'style.css' }],
        plugin: async (codeMirrorWrapper) => {
            const [noteId, configNoteId, darkMode, startToken, endToken] = await Promise.all([
                context.postMessage({ name: 'getNoteId', data: {} }),
                context.postMessage({ name: 'getSetting', data: { id: 'configNoteId' } }),
                context.postMessage({ name: 'getDarkMode', data: {} }),
                context.postMessage({ name: 'getSetting', data: { id: 'startToken' } }),
                context.postMessage({ name: 'getSetting', data: { id: 'endToken' } })
            ]);
            // Add an update listener: triggers on every document change
            codeMirrorWrapper.addExtension(configPlugin(context, noteId, configNoteId, darkMode, startToken, endToken));
        },
    };
};

const configPlugin = (context, noteId, configNoteId, darkMode, startToken, endToken) => ViewPlugin.fromClass(
    class {
        constructor(view) {
            try {
                this.noteId = noteId; // Tracks ID of currently opened note
                this.configNoteId = configNoteId; // Tracks ID of plugin's config note
                this.startToken = startToken;
                this.endToken = endToken;
                this.currentNoteLength = view.state.doc.length; // Helps detect when the note changes
                this.hotstrings = {};
                this.HoTsTrInGs = {};
                this.decorations = Decoration.none; // This is expected to be set, can cause crash if it takes too long
                this.setTokens().then(() => { // Changes the config note, if necessary, to synchronize startToken and endToken with settings
                    this.updateDecorations(view, true); // Defines hotstrings, HoTsTrInGs, and hotkeys - even if config note isn't open
                    view.dispatch({ effects: [] }); // Forces a visual update after the above Decoration.none, only relevant if config note is opened
                });
            } catch (e) { // Because crashes in here don't give errors otherwise...
                console.error(e);
            }
        }

        // Called every time the editor receives an update
        update(update) {
            try {
                if (update.docChanged) {
                    if (this.noteChanged(update)) { // Checks, synchronously, if the user changed to a new note
                        // This entire branch is just to avoid a flickering that happens in the config note if
                        // the note ID is verified every update - we only check the note ID if we think it might have changed
                        this.decorations = Decoration.none; // Can cause a crash if this isn't set quickly enough
                        // Get the new note ID now that we know it probably changed
                        context.postMessage({ name: 'getNoteId', data: {} }).then((noteId) => {
                            this.noteId = noteId;
                            this.updateDecorations(update.view, false); // See if we need to update the decorations
                            // Force a visual update since we set Decorations.none above, only relevant if we're in the config note
                            update.view.dispatch({ effects: [] });
                        });
                    } else {
                        this.replaceHotstring(update); // Checks if user typed a hotstring, replaces it if so
                        this.updateDecorations(update.view, false); // Adds styles if in the config note
                    }
                }
            } catch (e) {
                console.error(e);
            }
        }

        // Detects, synchronously, if the user changed notes
        noteChanged(update) {
            let noteChanged = false;
            update.changes.iterChanges( (fromA, toA, fromB, toB, inserted) => {
                if (
                    fromA === 0 && toA === this.currentNoteLength &&
                    fromB === 0 && toB === update.view.state.doc.length
                ) noteChanged = true;
            });
            // The above condition always happens on note changed - can have false positives too though
            // For example, would trigger if the user replaced the entire note at once
            this.currentNoteLength = update.view.state.doc.length;
            return noteChanged;
        }

        // Determines what config note-related actions should be taken
        updateDecorations(view, initialLoad) {
            if (this.noteId !== this.configNoteId) { // We are NOT in the config note
                this.decorations = Decoration.none;
                if (view.state.doc.line(1).text === '!!!HOTSTRINGS!!!') { // We are claiming this as the new config note
                    this.claimNote(view);
                } else if (initialLoad) {
                    // The plugin was just loaded - run this.parseConfigNote on the actual config note
                    // in order to define the hotstrings and hotkeys, don't apply styles
                    context.postMessage({ name: 'getConfigNote', data: {} }).then((note) => {
                        this.parseConfigNote(note, undefined);
                    });
                }
            } else { // We ARE in the config note
                if (view.state.doc.line(1).text === '!!!HOTSTRINGS!!!') { // We are claiming this as the new config note
                    this.claimNote(view);
                } else if (view.state.doc.line(1).text === '!!!HOTSTRINGSTUTORIAL!!!') { // User wants the tutorial posted
                    this.insertTutorial(view);
                } else if (view.state.doc.line(view.state.doc.lines).text === '!!!PREFILLHOTSTRINGS!!!') {
                    // User wants the pre-made hotstrings appended
                    this.insertPrefill(view);
                } else {
                    // User typed something else - re-apply styles and recalculate hotstrings and hotkeys
                    const note = view.state.doc.toString();
                    this.decorations = this.parseConfigNote(note, view);
                }
            }
        }

        // Parses the config note to define the hotstrings and hotkeys
        // Also applies CSS styles to the note if view is defined
        parseConfigNote(note, view) {
            let builder;
            if (view) {
                builder = new RangeSetBuilder();
            }
            // Matches all valid hotstring, hotkey, and token definitions
            const regex = /^[ \t]*([`'"])(.+?)\1\s*(::?:?=?)\s*([`'"])(.*?)\4\s*((#|\/\/).*)?$/gm;
            // Start fresh
            this.hotstrings = {};
            this.HoTsTrInGs = {};
            const hotkeys = {};
            const tokens = {};
            // Build an array of builder.add() actions, because they must appear in order
            // And we cycle through the document in reverse
            const actions = [];
            const matches = [...note.matchAll(regex)];
            // We go in reverse because we want lower-down definitions to override higher-up definitions
            // And going in reverse allows us to more easily detect when this happens, so custom styles
            // can be applied to the higher-up overridden definitions
            for (let i = matches.length - 1; i >= 0; i--) {
                const [line, leftQuote, left, separator, rightQuote, right, comment] = matches[i];
                // All that classes that will be applied to the line as a whole - will get one more
                let classes = darkMode ? 'hs-dark cm-inlineCode ' : 'hs-light cm-inlineCode ';
                if (separator.includes('=')) { // Can only be a token definition, uses :=
                    if (separator.length !== 2) continue; // Invalid separator, must be either ::= or :::=
                    if (left !== 'startToken' && left !== 'endToken') {
                        // These are the only valid tokens, so reject anything else
                        classes += 'hs-reject';
                    } else if (left in tokens) {
                        // Already been defined lower down - mark it as a repeat
                        classes += 'hs-repeat';
                    } else {
                        // Valid and novel, mark it and add it
                        classes += 'hs-token';
                        tokens[left] = right;
                        // Update the token in this class as well
                        this[left] = right;
                        // And let index.ts update it on the settings page
                        context.postMessage({ name: 'setSetting', data: { [left]: right } });
                    }
                } else if (separator.length == 1) { // Case-insensitive hotstring, :
                    if (left.toLowerCase() in this.hotstrings) {
                        // Already been defined lower down - mark it as a repeat
                        classes += 'hs-repeat';
                    } else {
                        classes += 'hs-match';
                        this.hotstrings[left.toLowerCase()] = right;
                    }
                } else if (separator.length == 2) { // Case-sensitive hotstring, ::
                    if (left in this.HoTsTrInGs) {
                        // Already been defined lower down - mark it as a repeat
                        classes += 'hs-repeat';
                    } else {
                        classes += 'hs-MaTcH';
                        this.HoTsTrInGs[left] = right;
                    }
                } else if (separator.length === 3) { // Hotkey, :::
                    const hotkey = this.normalizeHotkey(left);
                    if (!hotkey) {
                        // Hotkey combination is invalid for some reason, reject it
                        classes += 'hs-reject';
                    } else if (hotkey in hotkeys) {
                        // Already been defined lower down - mark it as a repeat
                        classes += 'hs-repeat';
                    } else {
                        classes += 'hk-match';
                        hotkeys[hotkey] = right;
                    }
                }
                if (view) {
                    // view is defined, so we are in the config note and are applying our decorations
                    // index of this match in the document as a whole, from start to finish
                    const matchFrom = matches[i].index;
                    const matchTo = matchFrom + line.length;
                    // Now we add our decorations, in order from highest index to lowest
                    if (comment) { // Always at the end
                        // These all use unshift, which appends to the left of the array - so the array is sorted
                        // by actions from lowest index to highest
                        actions.unshift(() => builder.add(
                            matchFrom + line.indexOf(comment),
                            matchTo,
                            Decoration.mark({ class: 'hs-comment' })
                        ));
                    }
                    // These constants just help avoid edge cases where right === left
                    // Applies decoration to the entire right, including its quotes
                    // Earliest index the right can start at in line
                    const startIndexRight = line.indexOf(leftQuote) + left.length + separator.length + 2;
                    const fullRight = rightQuote + right + rightQuote;
                    const c = matchFrom + line.indexOf(fullRight, startIndexRight);
                    actions.unshift(() => builder.add(
                        matchFrom + line.indexOf(fullRight, startIndexRight),
                        matchFrom + line.indexOf(fullRight, startIndexRight) + fullRight.length,
                        Decoration.mark({ class: 'hs-right' })
                    ));
                    // Applies decorations to the entire left, including its quotes
                    const startIndexLeft = matchFrom + line.indexOf(leftQuote);
                    const b = startIndexLeft;
                    actions.unshift(() => builder.add(
                        startIndexLeft,
                        startIndexLeft + left.length + 2, // + 2 to include the quotes
                        Decoration.mark({ class: 'hs-left' })
                    ));
                    // Applies decorations to the entire line
                    actions.unshift(() => builder.add(
                        matchFrom,
                        matchFrom,
                        Decoration.line({ attributes: { class: classes } })
                    ));
                }
            }
            // Send the hotkeys to index.ts to be parsed there, no need to wait on it
            context.postMessage({ name: 'setHotkeys', data: { hotkeys } });
            if (view) {
                // actions now has all our builder.add() calls in order from smallest index to largest
                // evaluate them and return the builder
                actions.forEach((action) => action());
                return builder.finish();
            }
        }

        // Checks if what the user typed completed a valid hotstring, and replaces it if so
        replaceHotstring(update) {
            update.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
                // Convert inserted to string
                const insertedText = inserted.toString();
                // Do nothing if no text was inserted, or more than 1 character was inserted, or the inserted text couldn't be part of our endToken
                if (!insertedText || insertedText.length !== 1 || (this.endToken !== '' && !this.endToken.endsWith(insertedText))) return;
                // Get the line where the insertion happened
                const line = update.state.doc.lineAt(fromB);
                // fromB = position in document of injected text
                // line.from = position in document of the start of this line of text
                // fromB - line.from = position in this line of the injected character, + insertedText.length (1) to include that character
                const lineTextUpToCursor = line.text.slice(0, fromB - line.from + 1);
                // Checks all defined hotstrings to see if we have a match in this slice, defines these three variables if so
                let { startPos, endPos, replacement } = this.getHotstringReplacement(lineTextUpToCursor);
                if (startPos !== undefined) {
                    // Make \n and \t be literal newlines and tabs
                    replacement = replacement
                        .replace(/\\\\n/g, '__ESCAPED_N__')
                        .replace(/\\\\t/g, '__ESCAPED_T__')
                        .replace(/\\n/g, '\n')
                        .replace(/\\t/g, '\t')
                        .replace(/__ESCAPED_N__/g, '\\n')
                        .replace(/__ESCAPED_T__/g, '\\t');
                    // You can't call a new update from within an update, it throws an exception
                    // This function is called from within an update
                    // So, use setTimeout(..., 0) to defer the update until the current stack finishes
                    setTimeout(() => {
                        update.view.dispatch({
                            changes: {
                                from: fromB + startPos, // fromB is from the last char of the endToken, so startPos is negative
                                to: fromB + endPos, // endPos is always 1, because the inserted character is always length 1
                                insert: replacement
                            }
                        });
                    }, 0);
                    // Keep this updated, we probably changed the note length
                    this.currentNoteLength += replacement.length - (endPos - startPos);
                }
            });
        }

        // Finds if lineTextUpToCursor ends in a valid hotstring
        // If so, returns its start and end positions within that hotstring
        // and the replacement output itself
        getHotstringReplacement(lineTextUpToCursor) {
            let startPos,
            endPos,
            hotstring = '', // The hotstring detected
            replacement;
            // Search case-sensitive HoTsTrInGs first
            for (const [key, value] of Object.entries(this.HoTsTrInGs)) {
                // The hotstring, surrounded by the start and end tokens
                const token = this.startToken + key + this.endToken;
                // See if our line of text ends in this - meaning the user typed it out
                if (lineTextUpToCursor.endsWith(token) && key.length > hotstring.length) {
                    // We don't break out of the loop when we succeed, because we want to find
                    // the LONGEST matching hotstring, for consistent/predictable behavior
                    endPos = 1; // Relative to fromB - because the inserted string is always length 1
                    startPos = endPos - token.length;
                    hotstring = key;
                    replacement = value;
                }
            }
            if (startPos === undefined) {
                // Failed to find a case-sensitive hotstring, check the case-insensitive ones now
                lineTextUpToCursor = lineTextUpToCursor.toLowerCase(); // Because case-insensitive
                for (const [key, value] of Object.entries(this.hotstrings)) {
                    const token = this.startToken + key.toLowerCase() + this.endToken;
                    if (lineTextUpToCursor.endsWith(token) && key.length > hotstring.length) {
                        endPos = 1; // Relative to fromB - because the inserted string is always length 1
                        startPos = endPos - token.length;
                        hotstring = key;
                        replacement = value;
                    }
                }
            }
            return { startPos, endPos, replacement };
        }

        // Modifies the last definitions of startToken and endToken in the config note, if present, to
        // match their values in the plugin settings. Runs on this plugin's initial load - necessary because
        // otherwise changing the tokens in the settings page would be immediately reverted by the config note
        async setTokens() {
            // Get config note body
            const configNote = await context.postMessage({ name: 'getConfigNote', data: {} });
            if (!configNote) return; // config note is empty or not defined
            // Function to find the lowest matching regex in text, and replace its right side with newToken
            const replaceToken = (text, regex, newToken) => {
                let lastMatch;
                for (const match of text.matchAll(regex)) {
                    // We only care about the lowest match
                    lastMatch = match;
                }
                if (!lastMatch) return text; // No matches

                const [fullMatch, leftQuote, left, separator, rightQuote, right, comment] = lastMatch;
                if (right === newToken) return text; // The token already matches, do nothing
                const matchIndex = lastMatch.index; // Starting index of the definition in text as a whole
                const sepIndex = fullMatch.indexOf(separator)+2; // Earliest index in fullMatch that right can appear at
                // Index in fullMatch where the right (and its quotes) begins at ...
                const tokenIndex = matchIndex + fullMatch.indexOf(rightQuote + right + rightQuote, sepIndex);
                // ... and ends at
                const tokenEnd = tokenIndex + right.length + 2;

                const newQuotedToken = rightQuote + newToken + rightQuote;
                // Cut out the old token, slice in the new token, return the altered text
                return text.slice(0, tokenIndex) + newQuotedToken + text.slice(tokenEnd);
            };
            // Run above function to replace lowest startToken and endToken with our new ones
            let newNote = replaceToken(configNote, /^[ \t]*([`'"])(startToken)\1\s*(:=)\s*([`'"])(.*?)\4\s*((#|\/\/).*)?$/gm, this.startToken);
            newNote = replaceToken(newNote, /^[ \t]*([`'"])(endToken)\1\s*(:=)\s*([`'"])(.*?)\4\s*((#|\/\/).*)?$/gm, this.endToken);
            // Only bother updating if it's actually been changed'
            if (newNote !== configNote) await context.postMessage({ name: 'setConfigNote', data: { content: newNote } })
        }

        // Claims the currently opened note as the new plugin config note
        claimNote(view) {
            if (this.configNoteId === this.noteId) {
                const lines = 'This is already the Hotstrings plugin config note. '
                setTimeout(() => {
                    view.dispatch({
                        changes: {
                            from: view.state.doc.line(1).from,
                            to: view.state.doc.line(1).to,
                            insert: lines
                        }
                    });
                }, 0);
                return;
            }
            this.configNoteId = this.noteId;
            // Update the config note ID on the settings page
            context.postMessage({ name: 'setSetting', data: { configNoteId: this.noteId } });
            // Let the user know they were successful
            let lines = `This note has been successfully claimed as the Hotstrings plugin config note. You may delete this message (and anything else in this note) if desired.\nTo see a tutorial for how to use this plugin, replace the first line of this note with !!!HOTSTRINGSTUTORIAL!!!.\nTo prefill the end of this note with a huge number of hotstrings, replace the last line of this note with !!!PREFILLHOTSTRINGS!!!.\n\n"startToken" := "${this.startToken}"\n"endToken" := "${this.endToken}"`;
            setTimeout(() => {
                view.dispatch({
                    changes: {
                        from: view.state.doc.line(1).from,
                        to: view.state.doc.line(1).to,
                        insert: lines
                    }
                });
            }, 0);
        }

        // Inserts the plugin tutorial to the top of the config note
        insertTutorial(view) {
            let lines = tutorial.replace(/%startToken%/g, this.startToken).replace(/%endToken%/g, this.endToken);
            setTimeout(() => {
                view.dispatch({
                    changes: {
                        from: view.state.doc.line(1).from,
                        to: view.state.doc.line(1).to,
                        insert: lines
                    }
                });
            }, 0);
        }

        // Appends pre-made hotstrings to the bottom of the config note
        insertPrefill(view) {
            let lines = prefill.replace(/%startToken%/g, this.startToken).replace(/%endToken%/g, this.endToken);
            setTimeout(() => {
                view.dispatch({
                    changes: {
                        from: view.state.doc.line(view.state.doc.lines).from,
                        to: view.state.doc.line(view.state.doc.lines).to,
                        insert: lines
                    }
                });
            }, 0);
        }

        // Takes an input string intended to represent a hotkey
        // Normalizes its spelling, capitalization, and order
        // Returns said normalized string if the hotkey is valid
        // Returns false if the hotkey contains unrecognized or invalid pieces
        normalizeHotkey(input) {
            if (typeof input !== 'string' || !input) return false;
            // Remove whitespace, make lowercase, split on +'s
            const keys = input.replace(/\s+/g, '').toLowerCase().split('+');
            if (!keys.length) return false;
            // Below objects used to normalize spelling and capitalization of key names
            const modifiers = {
                ctrl: 'Ctrl', control: 'Ctrl',
                alt: 'Alt',
                shift: 'Shift',
                // Joplin bug prevents safe use of Super key, unfortunately
                //meta: 'Super', cmd: 'Super', command: 'Super', win: 'Super', windows: 'Super', super: 'Super'
            };
            const keyNames = {
                capslock: 'Capslock', caplock: 'Capslock',
                esc: 'Esc', escape: 'Esc',
                up: 'Up', down: 'Down', left: 'Left', right: 'Right',
                enter: 'Enter', return: 'Enter',
                tab: 'Tab',
                backspace: 'Backspace',
                del: 'Delete', delete: 'Delete',
                ins: 'Insert', insert: 'Insert',
                home: 'Home', end: 'End',
                pgup: 'PageUp', pageup: 'PageUp',
                pgdown: 'PageDown', pagedown: 'PageDown',
                prtsc: 'PrintScreen', printscreen: 'PrintScreen',
                space: 'Space'
            };
            for (let i = 1; i <= 24; i++) keyNames[`f${i}`] = `F${i}`; // F1 to F24

            // Used to de-duplicate keys
            const seenKeys = new Set();
            // This must be exactly 1 by the end
            let nonModifierKeys = 0;
            for (const key of keys) {
                if (modifiers[key]) { // Any number of modifier keys allowed
                    seenKeys.add(modifiers[key]);
                } else if (keyNames[key]) { // Need *precisely* 1 non-modifier key
                    if (++nonModifierKeys > 1) return false;
                    seenKeys.add(keyNames[key]);
                } else if (/^[a-z0-9`\-=\\\]\[';/.,{}]$/.test(key)) { // a-z, 0-9, and: `-=\][';/.,{}
                    if (++nonModifierKeys > 1) return false;
                    seenKeys.add(key.toUpperCase());
                } else {
                    // Unknown or disallowed key
                    return false;
                }
            }
            if (nonModifierKeys === 0) return false;

            // Used to deterministically order the keys of the hotkey
            // Keeping Super in here because I'm optimistic for the future'
            // Order is modifiers with custom order first, everything else alphabetically second
            let keyOrder = ['Ctrl', 'Super', 'Alt', 'Shift', 'Backspace', 'Capslock', 'Delete', 'Down', 'End', 'Enter', 'Esc'];
            for (let i = 1; i <= 24; i++) keyOrder.push(`F${i}`); // F1 to F24
            keyOrder = keyOrder.concat(['Home', 'Insert', 'Left', 'PageDown', 'PageUp', 'PrintScreen', 'Right', 'Tab', 'Up']);

            let orderedKeys = [];
            // Add keys by their order in keyOrder, delete them from the set as we go
            for (const key of keyOrder) {
                if (seenKeys.has(key)) {
                    orderedKeys.push(key);
                    seenKeys.delete(key);
                }
            }
            // At this point, if anything remains in seenKeys, it is a sing single-character key like F or =
            orderedKeys.push(...seenKeys)
            return orderedKeys.join('+');
        }
    },
    {
        decorations: instance => instance.decorations
    }
);

// Benchmarks two functions against one another, alternates calls to avoid ordering bias
function timeAlternating(fn1, args1, fn2, args2, iterations = 10000) {
    let time1 = 0, time2 = 0;
    // Warmup
    for (let i = 0; i < 50; i++) {
        fn1(...args1);
        fn2(...args2);
    }
    for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        if (i % 2 == 0) {
            fn1(...args1);
            time1 += performance.now() - start;
        } else {
            fn2(...args2);
            time2 += performance.now() - start;
        }
    }
    console.error(`${fn1.name}: ${time1.toFixed(2)} ms for ${iterations/2} iterations`);
    console.error(`${fn2.name}: ${time2.toFixed(2)} ms for ${iterations/2} iterations`);
}
