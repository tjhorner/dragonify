import Docker from "dockerode"
import EventEmitter from "events"

import { chain } from "stream-chain"
import { parser } from "stream-json/jsonl/Parser"

export function getEventStream(docker: Docker): EventEmitter {
  const emitter = new EventEmitter()

  opts = {
    type: "container",
  }

  docker.getEvents(opts, (err, rawStream) => {
    const stream = chain<any[]>([
      rawStream,
      parser()
    ])

    stream.on("data", (data) => {
      const eventTypeAction = data.value.Type + data.value.Action
      if (eventTypeAction !== "container.start" && eventTypeAction !== "container.stop") {
        return
      }

      emitter.emit(eventTypeAction, data.value)
    })
  })

  return emitter
}
