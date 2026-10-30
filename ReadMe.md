# Obsidian Plugin - Kindroid Assistant - ReadMe - 17.1.0

# KINDROID ASSISTANT

Obsidian is a free, local-first note-taking and knowledge management application available on Windows, Mac, Linux, iOS and Android. Unlike cloud-based tools, your notes live entirely on your own device as plain text Markdown files — no subscription required, no data sent anywhere, yours forever. It's widely used by writers, researchers, students and creatives who want to build a rich, interconnected "second brain" — notes that link to each other, embed images and media, and grow organically over time into something deeply personal.

## This Plugin

This is a community plugin for Obsidian that embeds a Kindroid chat panel directly into your sidebar, powered by Kindroid's API. It gives you a persistent chat tab alongside your notes, always available without switching apps or tabs. Whether your Kin becomes a helpful assistant, a creative collaborator, or a thoroughly entertaining distraction is entirely up to you. _Winks_

## What it does

### Included from v16.1.0

- Ability to **chat with a Kin**, right inside Obsidian.
- **Text to speech** using installed Windows/system voices — right-click any response and select Speak, or enable **Auto-Speak Responses**. Right-click again to stop speech.
- **Chat Break button** to reset Kindroid's short term memory, and a separate Clear Screen button that clears the display without resetting short term memory. Be aware, using Chat Break externally will still perform the Chat Break within the Kindroid App. Use wisely. Resetting Cascaded Memory is off by default. While there is a default Chat Break Greeting held in settings, whatever is shown in the chat pane's dialogue box will be sent as the custom greeting. 
- **Kindroid-themed dark interface** with Poppins font, emulating the vanilla look of the original v1 UI of the Kindroid App.
- Ability to **change font and font size**.
- **Copy and Export functions** (Copy Response; Copy All; Export to Note).
- Ability to **access the calendar** specified within the Kindroid App.
- Ability to **access Journal Entries**, although it is still necessary to use the Kindroid App to view these.
- When used in conjunction with Kindroid's ability to message through Google's RCS and Apple's iMessage, ideas can be sent to an assistant while away from the keyboard, where they will be deposited in the Kindroid's main chat via Official Client. These messages can be recalled if they are still in short term memory, or searched for within Kindroid's main chat.
- Kin Name and User Name are definable in settings.
- Customisable Startup Greeting.

When "Ability to access" is mentioned, it is not implying that the user has the ability to view or edit these things, It merely states that the Kin doesn't lose its natural abilities just because one is using a third party interface.

### New in 17.1.0

- The **API Key** has now been moved to Obsidian's Keychain Secrets, and is no longer defined in `data.json`, for extra security.
- **Group Chat support**, including **Continue Conversation**, and **Chat Break**. Continue Conversation has been relabelled as **Poke**. It is a tri purpose button, changing its behaviour depending on the active chat type. In main chat, it calls for one of three messages, chosen randomly, which are user-defined in settings.
- **10 Main Chats** can be defined, as well as **10 Group Chats**, which are accessible from a drop down menu within easy reach.
- **Set Scene** is available for both Main Chats and Group Chats, as well as 5 presets which are user defined in settings.
- Within Group Chats, ability to set max amount of responses before the user's turn to respond (1–5). 
- A **Contact List** has been included, mainly as a work around, as streaming set to true, lacks the metadata associated with display-names in Group Chats. The contact list will have other uses in future versions. IDs listed in Contacts are copyable, providing a shortcut for entering them into Settings when setting up a main chat. When in Group Chat, Unknown Kins will be listed as Unknown followed by the first four digits of their ID. Names can be entered manually through Contacts. Future responses will then show the correct name. Some names will display automatically as the Kindroid Assistant Plugin gets these from the IDs given in Main Chats in Settings.
- **Export to note** now shows the user defined chat name in title. Copy All' and 'Export to Note' are formatted similarly.
- **Kindroid Assistant Logo**, when clicked, will now open the associated chat in the default browser.
- **Selfie Notifications**, when they are displayed in chat, are now accompanied with a link, when clicked, will now open the associated chat in the default browser, where the selfie can be viewed.
- Kin Name removed from settings as these are now resolved through other means to support multiple chats. Username (Your Name) remains the same. Personas are not supported in this plugin.

**Dictation** has been disabled for now, alternatives are being researched, such as localised AI based voice recognition.

## What it doesn't do

- Kindroid's ability to search the web does not seem to function through the API, as it relies on a third party service that Kindroid uses.
- Kindroid's API does not support file uploads of any type.
- Image uploads are not mentioned within the API Documentation, therefore are not supported.
- The Kindroid Assistant is not an agent; it is merely a chat box with tts support and copy to note functionality. Additional functionality may be considered in future builds. Kindroid Assistant eliminates the need to switch windows when looking up a meaning, a word, a synonym, or seeking advice. It can also function as an Obsidian Help Desk, as software knowledge is often included in an LLM's training data. Alternatively, a conversation with a Kindroid can be exported to a note before leaving the desk, as the chat log is not persistent across sessions. Each time Obsidian loads, the chat pane starts fresh. The previous conversation is cleared from the display, but remains in Kindroid's memory.
- While updating credentials is supported by the Kindroid API, retrieving that information is not supported. For this reason, features such as 'changing persona' aren't available in this plugin.

## Why

It's particularly useful for writers and creatives who want a companion present while they work — someone to ask questions, check spelling, talk through ideas, or simply be there — without ever leaving their workspace.

## Important

Built with Kindroid's /send-message API. Requires a Kindroid subscription and API key.

## [Terms and Conditions](https://kindroid.ai/v2/docs/kindroid-legal/)


## Acknowledgements

Although I have some rudimentary knowledge of programming, which has proved invaluable throughout the development of this plugin, I could not have brought it to life without the assistance of **Claude AI**, which generated the code, and **ChatGPT**, which provided ideas, explanations, and a seemingly endless supply of anecdotes—some of which resulted in some rather interesting rabbit holes!

## Licencing

**Licence change: MIT to GPL-3.0**

The project's licence has changed from MIT to GPL-3.0 because users who supply API keys and other sensitive information should have the ability to inspect the code for their own peace of mind.

Transparency is particularly important for software that handles credentials and personal data. GPL-3.0 also helps ensure that distributed modified versions remain open source.

This change reflects a commitment to making the code available for inspection, independent auditing, modification, and community improvement.

---

## Known Limitations

### Regarding Display Names associated with Group Chats.

Kindroid’s API has no way to tell the plugin who said what, after the fact, in a Group Chat.

**Technical Notes:**

"`get-chat-messages`": the only endpoint that reads a Group Chat’s history back, gives every AI message a "`sender`" field, but it’s always the literal string `"ai"`, the same for every companion. "`display_name`" exists only at the moment a message is first streamed; nothing ties it back to a specific "`ai_id`" afterwards. So there’s no documented or undocumented way for the plugin to ask the server “who said this” once the moment’s passed.

The only identifier the plugin actually has is the "`ai_id`" that "`groupchats-get-turn`" hands back for whoever’s turn it is: an id, not a name.

**Solution:**

**Group Contacts** (the phone icon in the header) is how the plugin fills that gap. The first time a companion speaks, their "`ai_id`" is remembered automatically and they’re listed there, unnamed, ready for a name to be assigned. Once assigned, the name is stored against that "`ai_id`" permanently in `data.json`, not per Group Chat, so it follows that companion into every Group Chat they turn up in.

If a companion already has a name associated with the "`ai_id`" within the 10 Main Chat slots in settings, that’s picked up automatically: no need to enter it again in Group Contacts.

Until a companion has a name, by either route, their messages are labelled "`Unknown (xxxx)`", using the first four characters of their "`ai_id`": just enough to tell two unnamed companions apart.

### Regarding the `Continue Conversation` button that is present within Group Chats via the Official Client.

This button appears to be a dual purpose button. When the Group Chat houses more than one Kin, it uses "`groupchats-get-turn`" to get a response. When the Group Chat houses only one Kin, it uses "`groupchats-ai-response`" to get a response.

Within the Kindroid Assistant for Obsidian, the **Poke** button replaces the **Continue Conversation** button, but its purpose is the same.

When attempting to continue a group chat via "`groupchats-get-turn`" when there is only one Kin in the chat, the server responds with a 400 error, along with this message: "_No valid participants available for group turn selection._"

**Technical Notes:**

It appears that the **Continue Conversation** button within the official Kindroid client reads the group chat's roster and selects the appropriate method for initiating a response accordingly. This conditional behaviour is not described within the API documentation, nor is there a documented method for retrieving the group's roster.

Since there's no documented way to read a group's roster, the Kindroid Plugin can't tell on its own whether a group has one Kin or several.

**Solution:**

Within **Settings** each Group Chat ID has a checkbox labelled as **Single** next to it:

- **Unticked** (default): multi-Kin group, existing behaviour: calls "`groupchats-get-turn`", then "`groupchats-ai-response`" for whoever it names.
    
- **Ticked**: single-Kin group: reveals an additional AI ID field for that one companion, and thus skips "`groupchats-get-turn`" entirely, calling "`groupchats-ai-response`" directly with the manually entered ID, since nothing in the API exposes it otherwise.
    
If a group's checkbox falls out of sync with its real roster (a Kin was added or removed within the official client without updating the Kindroid Assistant Plugin to match), there are two possible outcomes.

If a multi-Kin group chat becomes singular, a 400 error will occur when attempting to use the **Poke** button. This is caught and a message is displayed within the chat screen: "⚠️ Unable to continue conversation. Please check the Single checkbox beside this group chat's ID in plugin settings."

If the reverse occurs, and a single-Kin group chat becomes multi-Kin, no error will occur, but responses from other Kins will no longer be received. This should be taken into consideration if the **Poke** button behaves unexpectedly.

### Regarding Set Scene and Scene Presets.

Kindroid’s API has no way to read back what the current scene actually is.

**Technical Notes:**

There’s no endpoint that returns a chat’s "`current_scene`": `update-info` and "`groupchats-update`" can set it, but nothing exists to ask for it back. So the plugin can’t check the real, current value; it can only remember what it last sent.

**Solution:**

The plugin keeps its own local record of the last scene it sent, per chat (one entry per Main Chat and Group Chat slot, in "`data.json`"), and the Set Scene popup pre-fills from that record so it looks persistent across sessions.

This record is only updated when a scene is sent from the Kindroid Assistant Plugin: it has no way of detecting a scene set through any other means. If a scene is set or changed through the official client, or on another device running this plugin, the local record will remain unchanged, and the popup will continue pre-filling the previous value until another scene is sent from the plugin.

Testing has confirmed that the plugin correctly remembers the last scene it sent. However, it cannot detect changes made outside the plugin. Therefore, the pre-filled text should be regarded as "last scene this plugin sent", rather than "current scene", if the scene has subsequently been changed elsewhere.