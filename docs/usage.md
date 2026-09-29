# How to use

Back to the [README](../README.md).

Once Whazaa is set up, you talk to Claude in plain language. You never need to know about tool names or parameters -- just say what you want.

## Sending Messages

Tell Claude what to say and to whom:

- "Send Alex a message saying I'll be late"
- "Tell Nicole the meeting is moved to 3pm"
- "Message my self-chat: pick up milk"

If you don't say who to send it to, Claude sends to your own WhatsApp -- useful for notes to yourself.

## Voice Notes

Claude can send a WhatsApp voice note instead of a text message:

- "Send me a voice note saying good morning"
- "Send a voice note to Nicole saying I'm on my way"
- "Tell George via voice note that dinner is at 7"

You can choose whose voice to use:

- "Say it as George" or "Use George's voice"
- "Send that as a voice note in Daniel's voice"
- "Use Nicole's voice for this"

See the full voice list at the bottom of this section.

## Listening Locally (Mac Speakers)

Claude can speak out loud through your Mac -- no WhatsApp needed:

- "Say that out loud"
- "Read that to me"
- "Talk to me" or "Say it through the speakers"

Great for when you want an audio response right now, without sending anything to your phone.

## Voice Mode -- Hands-Free

Instead of switching to voice one message at a time, you can put Claude into a persistent voice mode so every response comes back as audio automatically.

**Voice notes to your phone:**

- "Voice mode on" or "Respond via voice" -- every Claude response becomes a WhatsApp voice note
- "Back to text" or "Text mode" -- back to normal text messages

**Audio through your Mac speakers:**

- "Talk to me locally" or "Local voice mode" -- every response plays through your speakers
- "Back to text" -- turns it off

Voice mode is perfect for driving, cooking, or any time you can't look at a screen.

## Switching Voices

The default voice is Fable (British male). You can switch voices by name:

- "Hi Nicole" -- switches to Nicole's voice
- "Hi George" -- switches to George's voice
- "Hi Daniel" -- switches to Daniel's voice
- "Default voice" or "Back to default" -- back to Fable

Voice switches are remembered for the session. You can also set a different default in the config.

## Chat History

Claude can look up your WhatsApp conversations directly -- it reads from WhatsApp Desktop's local database, so it's fast and doesn't require your phone to be online:

- "Show me my chats" -- lists your recent conversations
- "Show messages from Alex" -- shows recent messages from that contact
- "What did Nicole say last?" -- Claude finds the conversation and reads it

## Sending Images

Send an image to your WhatsApp self-chat and Claude sees it. The hub downloads the image and types the file path into your active Claude session -- Claude reads it natively.

- Send an image from your phone with the caption "What's this error?"
- Send a photo of a whiteboard with "Transcribe this"
- Send a design mockup with "Implement this layout"

If the image has a caption, it arrives on the same line as the path so Claude gets both the image and your instruction in one go. Supports JPEG, PNG, WebP, GIF, and stickers.

## Voice Notes In

Send a voice note to your self-chat and Claude receives the transcription. The hub downloads the audio, runs it through Whisper locally (`large-v3-turbo` model), and types the transcript into your Claude session.

- Record a voice note while walking: "Add a retry mechanism to the API client" -- Claude gets the text and starts working
- Dictate a bug report: "The login page crashes when I tap submit without filling in email"
- Voice notes from other contacts are also transcribed and available via `whatsapp_receive`

Works in English, German, and 90+ other languages. Transcription runs entirely on your Mac -- nothing leaves your machine.

## Screenshots

Send `/ss` from your phone and the hub captures the active Claude session's iTerm2 window and sends it back to WhatsApp as an image. Useful for checking on long-running tasks without switching to your desk.

The hub raises the correct window and selects the correct tab before capturing, so you always get the right session -- even if iTerm2 is in the background or another window is on top.

## Session Management (from Your Phone)

You can control your Claude sessions from WhatsApp itself. Send these commands to your self-chat:

- `/s` -- see a list of your active Claude sessions (each Claude window is a session)
- `/2` -- switch to session 2
- `/2 Cooking Project` -- switch to session 2 and name it

This is useful when you have multiple Claude windows open for different projects. Session state is managed entirely by the AIBroker hub.

## Available Voices

28 voices across four categories:

| Category | Voices |
|----------|--------|
| American Female | af_heart, af_alloy, af_aoede, af_bella, af_jessica, af_kore, af_nicole, af_nova, af_river, af_sarah, af_sky |
| American Male | am_adam, am_echo, am_eric, am_fenrir, am_liam, am_michael, am_onyx, am_puck, am_santa |
| British Female | bf_alice, bf_emma, bf_isabella, bf_lily |
| British Male | bm_daniel, **bm_fable** (default), bm_george, bm_lewis |

All TTS synthesis runs locally on your Mac -- no audio is ever sent to any external service.

