import { Module } from '../lib/plugins.js'

Module({
  command: 'insta',
  package: 'downloader',
  description: 'Download Instagram photo/video'
})(async (message, match) => {

  if (!match) {
    return message.send('*ᴘʟᴇᴀꜱᴇ ᴘʀᴏᴠɪᴅᴇ ᴀɴ ɪɴꜱᴛᴀɢʀᴀᴍ `ʟɪɴᴋ`*')
  }

  try {

    // Download start reaction
    await message.react("⬇️")

    const SABIR7718 = `https://social-media-downloader-api-s7.onrender.com/sylove?url=${encodeURIComponent(match)}`

    const S7HaTeSY = await fetch(SABIR7718)
    const HaTe = await S7HaTeSY.json()

    console.log(HaTe)

    if (!HaTe || !HaTe.video_url) {
      await message.react("❌")
      return message.send('*ɴᴏ ᴍᴇᴅɪᴀ ꜰᴏᴜɴᴅ ᴏʀ ᴀᴘɪ `ᴇʀʀᴏʀ`*')
    }

    await message.send({
      video: {
        url: HaTe.video_url
      },
      caption: '> *𝐃𝐇--𝐊 𝐗 𝐌𝐃*'
    })

    // Download completed reaction
    await message.react("✅")

  } catch (SYHaTe) {
    console.error(SYHaTe)

    await message.react("❌")
    return message.send('*ᴇʀʀᴏʀ `ᴏᴄᴄᴜʀʀᴇᴅ`*')
  }
})