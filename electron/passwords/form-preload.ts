import { ipcRenderer } from "electron";
import { FORM_CHANNELS, watchForms } from "./form-dom";

// The frame preload every page session registers, so it runs in each frame
// of every tab and popup: sandboxed, where only "electron" can be required,
// and in an isolated world. It gives the page nothing and watches web
// documents only. It does nothing until main answers hello, and stops when
// hello is refused, as it is in contents without a form broker.
if (location.protocol === "http:" || location.protocol === "https:")
  watchForms({
    send: (channel, payload) =>
      ipcRenderer.send(FORM_CHANNELS[channel], payload),
    invoke: (channel) => ipcRenderer.invoke(FORM_CHANNELS[channel]),
    onMessage: (listener) => {
      ipcRenderer.on(FORM_CHANNELS.state, (_event, payload) =>
        listener("state", payload),
      );
      ipcRenderer.on(FORM_CHANNELS.fill, (_event, payload) =>
        listener("fill", payload),
      );
    },
  });
