import Docker from "dockerode"
import { getEventStream } from "./docker-events"
import { logger } from "./logger"

const NETWORK_NAME = "apps-internal"

async function setUpNetwork(docker: Docker) {
  logger.info(`Setting up network ${NETWORK_NAME}`)

  const existingNetworks = await docker.listNetworks({filters: {name: [NETWORK_NAME]}})
  if (existingNetworks.length === 1) {
    logger.info("Network already exists")
    return
  }

  await docker.createNetwork({
    Name: NETWORK_NAME,
    Driver: "bridge",
    Internal: true,
  })

  logger.info("Network created")
}

function getDnsName(container: Docker.ContainerInfo) {
  const service = container.Labels["com.docker.compose.service"]
  const project = container.Labels["com.docker.compose.project"]
  return `${service}.${project}.svc.cluster.local`
}

function prohibitedNetworkMode(networkMode: string) {
  return [ "none", "host" ].includes(networkMode) ||
    networkMode.startsWith("container:") ||
    networkMode.startsWith("service:")
}

async function connectContainerToAppsNetwork(docker: Docker, container: Docker.ContainerInfo) {
  if (prohibitedNetworkMode(container.HostConfig.NetworkMode)) {
    logger.debug(`Container ${container.Id} is using network mode ${container.HostConfig.NetworkMode}, skipping`)
    return
  }

  const network = docker.getNetwork(NETWORK_NAME)
  const dnsName = getDnsName(container)

  logger.debug(`Connecting container ${container.Id} to network as ${dnsName}`)

  try {
    await network.connect({
      Container: container.Id,
      EndpointConfig: {
        Aliases: [ dnsName ]
      }
    })
  } catch (e: any) {
    logger.error(`Failed to connect container ${container.Id} to network:`, e)
    return
  }

  logger.info(`Container ${container.Id} (aka ${container.Names.join(", ")}) connected to network as ${dnsName}`)
}

function isContainerInNetwork(container: Docker.ContainerInfo) {
  return container.NetworkSettings.Networks[NETWORK_NAME] !== undefined
}

function isIxProjectName(name: string | undefined) {
  return name?.startsWith("ix-") ?? false
}

function isIxAppContainer(container: Docker.ContainerInfo) {
  return isIxProjectName(container.Labels["com.docker.compose.project"])
}

async function connectAllContainersToAppsNetwork(docker: Docker) {
  logger.debug("Connecting existing app containers to network")

  const containers = await docker.listContainers({
    limit: -1,
    filters: {
      label: [ "com.docker.compose.project" ]
    }
  })

  const appContainers = containers.filter(isIxAppContainer)
  for (const container of appContainers) {
    if (isContainerInNetwork(container)) {
      logger.debug(`Container ${container.Id} already connected to network`)
      continue
    }

    await connectContainerToAppsNetwork(docker, container)
  }

  logger.info("All existing app containers connected to network")
}

async function connectNewContainerToAppsNetwork(docker: Docker, containerId: string) {
  const [ container ] = await docker.listContainers({
    filters: {
      id: [ containerId ]
    }
  })

  if (!container) {
    logger.warn(`Container ${containerId} not found`)
    return
  }

  if (isContainerInNetwork(container)) {
    logger.debug(`Container ${container.Id} already connected to network`)
    return
  }

  logger.debug(`New container started: ${container.Id}`)
  await connectContainerToAppsNetwork(docker, container)
}

async function main() {
  const docker = new Docker()

  await setUpNetwork(docker)
  await connectAllContainersToAppsNetwork(docker)

  const events = getEventStream(docker)
  events.on("container.start", (event) => {
    const containerAttributes = event.Actor.Attributes
    if (!isIxProjectName(containerAttributes["com.docker.compose.project"])) {
      return
    }

    connectNewContainerToAppsNetwork(docker, event.Actor["ID"])
  })
}

main()
