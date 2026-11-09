import Docker from "dockerode"
import {
  ContainerInfo,
  ContainerInspectInfo,
  Network,
  NetworkInfo,
  NetworkInspectInfo,
  NetworkContainer,
  NetworkCreateOptions
  } from "dockerode"
import { getEventStream } from "./docker-events"
import { logger } from "./logger"
import PQueue from "p-queue"
import fs from "fs"


type NetworksState = Record<string, { managed: string[], natif: string[] }>

const HEARTBEAT_FILE: string = process.env.HEARTBEAT_FILE ?? "dragonify-heartbeat"
const DRAGONIFY_NETWORK_LABEL = "tj.horner.dragonify.networks"
const DRAGONIFY_NETWORK_NAME: string = process.env.CUSTOMS_NETWORK_NAME?.toLowerCase() ?? "apps-internal"
const IX_DOCKER_LABEL = "com.docker.compose.project"
const ENV_CONNECT_ALL: string | undefined = process.env.CONNECT_ALL
const LOG_LEVEL: string | undefined = process.env.LOG_LEVEL?.toLowerCase() ?? "info"
const CONTAINER_BUILD_VERSION: string | undefined = process.env.CONTAINER_BUILD_VERSION?.toLowerCase() ?? "dev"
const IDLE_PRUNE_DELAY_MS = 2 * 60 * 1000
const MAX_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000

let CONNECT_ALL: boolean = true
if (ENV_CONNECT_ALL !== undefined && ENV_CONNECT_ALL == "false") {
  CONNECT_ALL = false
}

let DEBUG: boolean = false
if (LOG_LEVEL !== undefined && LOG_LEVEL == "debug") {
  DEBUG = true
}

logger.info(`Dragonify version: ${CONTAINER_BUILD_VERSION}`)
logger.info(`Dragonify starting...`)
logger.info(`LOG_LEVEL: ${LOG_LEVEL}`)
logger.info(`CONNECT_ALL: ${CONNECT_ALL}`)
if (CONNECT_ALL) {
  logger.info(`DRAGONIFY_NETWORK_NAME: "${DRAGONIFY_NETWORK_NAME}"`)
}
logger.info(`DRAGONIFY_NETWORK_LABEL: "${DRAGONIFY_NETWORK_LABEL}"`)

// We hold the Docker object instance globally to avoid having to pass it on every function call
const DOCKER: Docker = new Docker()



// ABAOUT TUPLES
///////////////////////////////////
// In order to connect, disconnect, and reconnect our containers to the right networks, we need to know a few things.
// First, we need to know which networks we want to connect a container to. We configure this with the LABEL “tj.horner.dragonify.networks”
// when configuring our service (docker-compose, for example).
// To do this, we will need to associate a container name with a network name (NETWORK <-> CONTAINER) and create a tuple [a,b] with [NETWORK_NAME, CONTAINER_NAME].
// This will give us a list of tuples like this:
// {
//     NETWORK_1: { managed: [CONTAINER_1] },
//     NETWORK_2: { managed: [CONTAINER_1,CONTAINER_2] },
//     NETWORK_3: { managed: [CONTAINER_3] },
//     .....
// }
// Dragonify will then be able to ensure that the container is properly connected to the network if it exists, and if the network does not exist,
// it will know that when it is created, this container must be associated with it.
// For example, if the network does not exist because it depends on a stack that has not yet been started,
// our container that starts up and contains the LABEL “tj.horner.dragonify.networks”: NETWORK_1 cannot connect to it.
// However, the NETWORK_1 <-> CONTAINER_1 tuple is recorded, so when NETWORK_1 starts up, Dragonify will know that it must connect CONTAINER_1 to it.

// Secondly, we want Dragonify to disconnect our container if the network to which it is associated disappears.
// Normally, when a composite stack is shutdown, all its containers are stopped, the network is empty and is destroyed.
// But because Dragonify adds an external container to this network, when a stack is shutdown, the container remains in the network and the network is not destroyed.
// We therefore want this container to be disconnected from the network in order to destroy the network, BUT only if the compose stack is shutdown. In other words,
// only if ALL the services in the stack (and not only if only one is restarted) are shutdown and have therefore disappeared from the network.
// To identify them, we can simply assume that they are all the containers present in THIS_NETWORK that do not contain
// the LABEL “tj.horner.dragonify.networks”: THIS_NETWORK that would connect them there.
// We therefore need to know, for each network, all the containers it contains that do not have the LABEL “tj.horner.dragonify.networks”: THIS_NETWORK
// and record this in a tuple [NETWORK_NAME, LIST_OF_CONTAINER_NAMES_WITHOUT_LABEL].
// This will give us a list of tuples like this:
// {
//     NETWORK_1: { natif: [CONTAINER_1,CONTAINER_2,CONTAINER_3] },
//     NETWORK_2: { natif: [CONTAINER_4,CONTAINER_5] },
//     NETWORK_3: { natif: [CONTAINER_6] },
//     .....
// }
// With this tuple, we will be able to know when a container is shutdown whether the network in which it is located is still being used by containers in the stack,
// whether only containers connected via Dragonify remain, or whether the network has become completely empty.
// If the network contains ONLY containers that have the LABEL “tj.horner.dragonify.networks”: THIS_NETWORK,
// then we can assume that all the containers contained in the network are shutdown, and we can therefore disconnect the containers with the label THIS_NETWORK
// and then, if the network is empty, delete it.

// Finally, to merge all this, we can consider merging these tuples to obtain an nesting of tuples [a,b] and {b.managed,b.natif} and obtain:
// {
//   "NETWORK_1": {
//     manager: ["CONTAINER_1"],
//     natif: ["CONTAINER_2"]
//   },
//   "NETWORK_2": {
//     manager: ["CONTAINER_1", "CONTAINER_4", "CONTAINER_5"],
//     natif: ["CONTAINER_3"]
//   },
//   "NETWORK_3": {
//     manager: ["CONTAINER_6"],
//     natif: ["CONTAINER_1","CONTAINER_7","CONTAINER_8"]
//   },
// }
// For each network, Dragonify knows which containers it has connected, it knows which containers belong to the stack,
// and it can decide to connect a container when the network is created, disconnect it when the stack disappears, and delete the network if necessary.




function writeHeartbeat() {
  try {
    fs.writeFileSync(HEARTBEAT_FILE, Date.now().toString())
  } catch (e: any) {
    logger.error(`Failed to write heartbeat file:`, e)
  }
}

function startHeartbeat() {
  const Heartbeat = async () => {
    try {
      // checks the Docker socket is still accessible
      await DOCKER.ping()
      if (!fs.existsSync(HEARTBEAT_FILE)) {
      writeHeartbeat()
      }
    } catch (e: any) {
      fs.unlink(HEARTBEAT_FILE, err => {
        if (err) {
          logger.warn(`Docker ping failed during healthcheck. An error occurred during the removal of ${HEARTBEAT_FILE}: ${err.message}`)
        } else {
          logger.warn(`Docker ping failed during healthcheck`)
        }
      })
    }
  }

  Heartbeat()
  // setInterval -> Calls a function or executes a code snippet, with a fixed time delay between each call
  setInterval(Heartbeat, 30 * 1000)
}




async function getAllContainer() {
  return await DOCKER.listContainers({ all: true })
}
async function filterNetworkByName(network_name: string) {
  return await DOCKER.listNetworks({filters: {name: [network_name]}})
}
async function filterContainers(filter_type: string, filter_value: string) {
  return await DOCKER.listContainers({
    filters: JSON.stringify({
      [filter_type]: [ filter_value ]
    })
  })
}
async function inspectNetwork(network_id: string) {
  return await DOCKER.getNetwork(network_id).inspect()
}
function getDnsName(container: ContainerInfo) {
  const service = container.Labels["com.docker.compose.service"]
  const project = container.Labels[IX_DOCKER_LABEL]
  return `${service}.${project}.svc.cluster.local`
}
function isIxProjectName(name: string) {
  return name?.startsWith("ix-") ?? false
}




function schedulePeriodicPrune(queue: PQueue) {
  // This function is the only one generated by AI
  let idleTimer: NodeJS.Timeout
  let lastPruneTime = Date.now()

  const runPrune = (reason: string) => {
    // Add prune task to queue
    queue.add(async () => {
      try {
        logger.debug(`Periodic network cleanup triggered (${reason} after the last container stopped)`)
        await removeEmptyNetwork()
        lastPruneTime = Date.now()
      } catch (error) {
        logger.error(`Network cleanup failed: ${error}`)
      }
    })
  }

  const resetIdleTimer = () => {
    // Clear timer on each execution to avoid multiple executions of prune (the new one replaces the previous one)
    clearTimeout(idleTimer)
    // setTimeout -> Execute a founction after a delay. Here execute runPrune after IDLE_PRUNE_DELAY_MS
    idleTimer = setTimeout(() => runPrune("idle 2min"), IDLE_PRUNE_DELAY_MS)
  }

  // Add timer each hour for check if prune need to be executed (min once a day)
  // setInterval -> Calls a function or executes a code snippet, with a fixed time delay between each call
  setInterval(() => {if (Date.now() - lastPruneTime >= MAX_PRUNE_INTERVAL_MS) {runPrune("daily safety net") }}, 60 * 60 * 1000)

  return resetIdleTimer
}




async function networkCreated(networksDragonifyed: NetworksState, created_network_name: string) {
  for (let [a,b] of Object.entries(networksDragonifyed)) {
    if (a === created_network_name) {
      for (let containername of b.managed) {
        let thisContainer = await filterContainers("name", containername)
        if (!thisContainer[0]) continue
        logger.info(`Reconnect "${thisContainer[0].Names.toString()}" to network "${a}"`)
        await connectContainers(thisContainer[0], created_network_name)
      }
    }
  }
}




async function removeContainerAndNetworkFromTuplesArray(networksDragonifyed: NetworksState, stopped_container_name: string) {
  // Remove the stopped container from all networks in array
  for (let [a, b] of Object.entries(networksDragonifyed)) {
    if (b.managed.includes(stopped_container_name)) {
      logger.debug(`Containers dragonified "${stopped_container_name}" is now stopped. Removed from "${a}" network list`)
    }
    b.managed = b.managed.filter(name => name !== stopped_container_name)
    b.natif = b.natif.filter(name => name !== stopped_container_name)
  }

  // Remove any networks that are now empty
  for (let [a,b] of Object.entries(networksDragonifyed)) {
    if (b.managed.length === 0 && b.natif.length === 0) {
      delete networksDragonifyed[a]
      logger.debug(`Network "${a}" is now empty and removed from list`)
    }
  }
}

async function disconnectContainers(networkInfo: NetworkInspectInfo, containerInfo: ContainerInfo) {
  try {
    await DOCKER.getNetwork(networkInfo.Id).disconnect({
    Container: containerInfo.Id
    })
    logger.debug(`Container "${containerInfo.Names}" is now disconnected from "${networkInfo.Name}".`)
  } catch (e: any) {
    if (DEBUG) {
      logger.debug(`Failed to disconnect container ${containerInfo.Names} ID:${containerInfo.Id} from network "${networkInfo.Name}". He's probably already stopped`, e)
    }
    else {
      logger.warn(`Failed to disconnect container ${containerInfo.Names} ID:${containerInfo.Id} from network "${networkInfo.Name}". He's probably already stopped`)
    }
  }
}

async function isAllContainerContainLabelTag(network: NetworkInspectInfo, listOfAllContainers: ContainerInfo[]) {
  // Check all containers connected to the network
  for (let containerInThisNetwork of Object.keys(network.Containers ?? {}) ) {
    // Get container info
    let thisContainerInList = listOfAllContainers.find(n => n.Id === containerInThisNetwork)
    // Check if container has the dragonify label with the network name
    if (!thisContainerInList) {
      logger.debug(`Container "${containerInThisNetwork}" found in network "${network.Name}" but not in container list, likely removed. Skipping.`)
      continue
    }
    let hasNetworkTag = thisContainerInList.Labels[DRAGONIFY_NETWORK_LABEL]?.split(',').includes(network.Name) ?? false

    // If one container does not have the label, return false
    if (!hasNetworkTag) {
      return false
    }
  }
  return true
}

async function removeContainerFromNetworks(networksDragonifyed: NetworksState, stopped_container_name: string) {
  for (let [a,b] of Object.entries(networksDragonifyed)) {
    if (b.natif.includes(stopped_container_name)) {
      let network = await filterNetworkByName(a)
      // Exit if network not found
      const matchedNetwork = network.find(n => n.Name === a)
      if (!matchedNetwork) {
        return
      }
      let thisNetwork = await inspectNetwork(matchedNetwork.Id)
      let listOfAllContainers = await getAllContainer()

      // Check if all containers in the network have the label before disconnecting
      if (await isAllContainerContainLabelTag(thisNetwork, listOfAllContainers)) {
        for (let containername of b.managed) {
          let thisContainer = listOfAllContainers.find(n => n.Names[0] === containername)
          if (!thisContainer) {
            continue
          }
          await disconnectContainers(matchedNetwork,thisContainer)
        }
      }
      else {
        logger.debug(`"${b.managed}" has not been disconnected from the network "${matchedNetwork.Name} "because other unmanaged containers are still present in it`)
      }
    }
  }
}

async function containerStop(networksDragonifyed: NetworksState, stopped_container_name: string) {
  await removeContainerFromNetworks(networksDragonifyed, stopped_container_name)
  await removeContainerAndNetworkFromTuplesArray(networksDragonifyed, stopped_container_name)
}




async function reConnectOldContainerToAppsNetwork(networksDragonifyed: NetworksState, containerInfo: ContainerInfo, listOfAllContainers: ContainerInfo[]) {
  for (let [a,b] of Object.entries(networksDragonifyed)) {
    if (b.natif.includes(containerInfo.Names.toString())) {
      for (let containername of b.managed) {
        let addContainer = listOfAllContainers.find(n => n.Names[0] === containername)
        if (!addContainer) {
          continue
        }
        // Pass if the container is already connected to the network
        if (isContainerInNetwork(addContainer, a)) {
          logger.debug(`Container "${addContainer.Names.toString()}" ID:${addContainer.Id} already connected to network "${a}"`)
          continue
        }

        logger.info(`Reconnect "${addContainer.Names.toString()}" to network "${a}"`)
        await connectContainers(addContainer, a)
      }
    }
  }
}

async function aggregateOldContainersTuplesArray(networksDragonifyed: NetworksState, containerInfo: ContainerInfo) {
  let specifiedNetwork: string[] = []
  if (isDragonifyLabeled(containerInfo.Labels)) {
    specifiedNetwork = containerInfo.Labels[DRAGONIFY_NETWORK_LABEL].split(',')
  }
  for (let network of Object.keys(containerInfo.NetworkSettings.Networks)) {
    for (let [a,b] of Object.entries(networksDragonifyed)) {
      if (a === network && !specifiedNetwork.includes(network)) {
        if (!b.natif.includes(containerInfo.Names.toString())) {
          b.natif.push(containerInfo.Names.toString())
        }
      }
    }
  }
}

async function connectNewContainerToAppsNetwork(networksDragonifyed: NetworksState, dockerEventID: string) {
  // Retrieve information from the container
  const container = await filterContainers("id", dockerEventID)

  // Exit if container is already stopped
  if (!container.find(n => n.Id === dockerEventID)) {
    logger.warn(`Container ${dockerEventID} not found. Maybe docker container runs a single command and is exited`)
    return
  }

  logger.debug(`New container started: ${container[0].Id}`)


  // Add d for old b containers in tuples
  await aggregateOldContainersTuplesArray(networksDragonifyed, container[0])

  // Create a list of networks to connect the container to
  const networkList = createNetworkListToConnect(container[0])

  // Connect the container to each network in the list
  let listOfAllContainers = await getAllContainer()
  await connectContainerToListedNetworks(networksDragonifyed, container[0], networkList, listOfAllContainers)

  // Connect all containers that were waiting for this network
  await reConnectOldContainerToAppsNetwork(networksDragonifyed, container[0], listOfAllContainers)

  logger.info(`"${container[0].Names}" is connected to all its networks`)
}

async function containerStart(networksDragonifyed: NetworksState, dockerEventID: string) {
  await connectNewContainerToAppsNetwork(networksDragonifyed, dockerEventID)
}




async function removeEmptyNetwork() {
  try {
    await DOCKER.pruneNetworks()
  } catch (e: any) {
    logger.error(`Exception during prune empty networks:`, e)
  }
}

function prohibitedNetworkMode(networkMode: string) {
  return [ "none", "host" ].includes(networkMode) ||
    networkMode.startsWith("container:") ||
    networkMode.startsWith("service:")
}

async function connectContainers(container: ContainerInfo, network_name: string) {
  // Do not connect if the container is using a prohibited network mode
  if (prohibitedNetworkMode(container.HostConfig.NetworkMode)) {
    logger.debug(`Container "${container.Names}" ID:${container.Id} is using network mode ${container.HostConfig.NetworkMode}, skipping`)
    return
  }

  const network = DOCKER.getNetwork(network_name)
  const dnsName = getDnsName(container)

  logger.debug(`Connecting container "${container.Names}" ID:${container.Id} to network "${network_name}" as ${dnsName}`)
  // Connect the container to the network with the DNS name
  try {
    await network.connect({
      Container: container.Id,
      EndpointConfig: {
        Aliases: [ dnsName ]
      }
    })
  } catch (e: any) {
    logger.error(`Failed to connect container "${container.Names}" ID:${container.Id} to network "${network_name}":`, e)
    return
  }

  logger.info(`Container "${container.Names}" ID:${container.Id} connected to network "${network_name}" as ${dnsName}`)
}

function isContainerInNetwork(container: ContainerInfo, network_name: string): boolean {
  if (container.NetworkSettings.Networks[network_name] !== undefined) {
    return true
  }
  return false
}

async function addContainerAndNetworkToTuplesArray(networksDragonifyed: NetworksState, containerInfo: ContainerInfo, networkInfo: NetworkInspectInfo, network_name: string, listOfAllContainers: ContainerInfo[]) {
  // Create a network entry in the table (a in tuple [a,b])
  if (!networksDragonifyed[network_name]) {
    networksDragonifyed[network_name] = {managed:[], natif:[]}
  }

  // Create container entry in the network entry (b in tuple [a,b])
  if (!networksDragonifyed[network_name].managed.includes(containerInfo.Names.toString())) {
    networksDragonifyed[network_name].managed.push(containerInfo.Names.toString())
  }

  // Exit if network does not exist and after creation of tuple [a,b] because we need [a,b]
  if (!networkInfo) {
    return
  }

  // Assigne b for b in [a,b] because a = network_name create earlier
  const b = networksDragonifyed[network_name]
  // Find for containers already connected to this network
  let inspectedNetwork = await inspectNetwork(networkInfo.Id)
  let containersInNetwork = inspectedNetwork.Containers ?? {}

  // Push each container already in network (a) in b.natif
  for (let containerID of Object.keys(containersInNetwork)) {
    let thisContainer = listOfAllContainers.find(n => n.Id === containerID)
    if (!thisContainer) {
      continue
    }

    // Verify if container contain Dragonify label
    if (isDragonifyLabeled(thisContainer.Labels)) {
      // Verify if label containe this network
      if (thisContainer.Labels[DRAGONIFY_NETWORK_LABEL].split(',').includes(networkInfo.Name)) {
        logger.debug(`"${thisContainer.Names.toString()}" is managed for "${networkInfo.Name}"`)
      }

      // Push container name in the tuple
      else {
        logger.debug(`"${thisContainer.Names.toString()}" IS manager but not for "${networkInfo.Name}". He was probably the one who created it.`)
        if (b.managed.includes(containerInfo.Names.toString()) && !b.natif.includes(thisContainer.Names.toString())) {
          b.natif.push(thisContainer.Names.toString())
        }
      }
    }

    // Push container name in the tuple
    else {
      logger.debug(`"${thisContainer.Names.toString()}" IS NOT managed for "${networkInfo.Name}". He was probably the one who created it.`)
      if (b.managed.includes(containerInfo.Names.toString()) && !b.natif.includes(thisContainer.Names.toString())) {
        b.natif.push(thisContainer.Names.toString())
      }
    }
  }

  logger.debug(`Container "${containerInfo.Names}" added to "${networkInfo.Name}" network list`)
}

async function connectContainerToListedNetworks(networksDragonifyed: NetworksState, container: ContainerInfo, networkList: string[], listOfAllContainers: ContainerInfo[]) {
  for (let i = 0; i < networkList.length; i++) {
    let network = await filterNetworkByName(networkList[i])
    // Implement the array
    await addContainerAndNetworkToTuplesArray(networksDragonifyed, container, network[0], networkList[i], listOfAllContainers)
    // Connect to the network if it exists
    if (network.find(n => n.Name === networkList[i])) {
      // Pass if the container is already connected to the network
      if (isContainerInNetwork(container, networkList[i])) {
        logger.debug(`Container "${container.Names}" ID:${container.Id} already connected to network "${networkList[i]}"`)
        continue
      }

      logger.info(`Connecting "${container.Names}" to "${networkList[i]}"`)
      await connectContainers(container, networkList[i])
    }
  }
}

function isDragonifyLabeled(labels: any): boolean {
  if (labels[DRAGONIFY_NETWORK_LABEL] !== undefined) {
    return true
  }
  return false
}

function createNetworkListToConnect(container: ContainerInfo) {
  let networkList:string[] = []

  // If CONNECT_ALL is true add the dragonify network to the list
  if (CONNECT_ALL) {
    logger.debug(`"${container.Names}" will be connected to all others`)
    networkList.push(DRAGONIFY_NETWORK_NAME)
  }

  // If the container has the dragonify label add its networks to the list
  if (isDragonifyLabeled(container.Labels)) {
    let individualNetworks: string[] = container.Labels[DRAGONIFY_NETWORK_LABEL].split(',')

    for (let i = 0; i < individualNetworks.length; i++) {
      networkList.push(individualNetworks[i])
    }
  }

  return networkList
}

async function connectAllContainersToAppsNetwork(networksDragonifyed: NetworksState) {
  logger.info("Connecting existing app containers to networks")

  // List all containers
  const listOfAllContainers = await getAllContainer()
  const appContainers = listOfAllContainers.filter(c => isIxProjectName(c.Labels[IX_DOCKER_LABEL]))

  // Connect each app container to its networks
  // let listOfAllContainers = await getAllContainer()
  for (const container of appContainers) {
    // Create a list of networks to connect the container to
    const networkList = createNetworkListToConnect(container)

    // Connect the container to each network in the list
    await connectContainerToListedNetworks(networksDragonifyed, container, networkList, listOfAllContainers)

    logger.info(`"${container.Names}" is connected to all its networks`)
  }
  logger.info("All configured app containers connected to their network")
}

async function setUpDragonifyNetwork() {
  const IS_DRAGONIFY_NETWORK_NAME = await filterNetworkByName(DRAGONIFY_NETWORK_NAME)

  // Create the Dragonify network if CONNECT_ALL is true
  if (CONNECT_ALL) {
    logger.info(`Setting up Dragonify network "${DRAGONIFY_NETWORK_NAME}" for connect all your containers`)

    // Check if the Dragonify network already exists
    if (IS_DRAGONIFY_NETWORK_NAME.find(n => n.Name === DRAGONIFY_NETWORK_NAME)) {
      logger.debug(`Network "${DRAGONIFY_NETWORK_NAME}" already exists`)
      return
    }

    // Create the Dragonify network
    try {
      await DOCKER.createNetwork({
        Name: DRAGONIFY_NETWORK_NAME,
        Driver: "bridge",
        Internal: true,
        Labels: {
          [DRAGONIFY_NETWORK_LABEL]: "true"
        },
      })
      logger.info(`Network "${DRAGONIFY_NETWORK_NAME}" created`)
    } catch (e: any) {
      if (e.statusCode !== 409) throw e
      logger.debug(`Network "${DRAGONIFY_NETWORK_NAME}" already exists (race condition)`)
    }
  }

  else {
    // Check if the Dragonify network already exists
    if (IS_DRAGONIFY_NETWORK_NAME.find(n => n.Name === DRAGONIFY_NETWORK_NAME)) {

      // Disconnect all containers from the network because CONNECT_ALL is false
      logger.info(`Network "${DRAGONIFY_NETWORK_NAME}" is present but CONNECT_ALL is false. This network will be remove.`)
      const INSPECT_NETWORK_NAME = await inspectNetwork(IS_DRAGONIFY_NETWORK_NAME[0].Id)
      const containers = INSPECT_NETWORK_NAME.Containers ?? {}
      for (const containerID of Object.keys(containers)) {
        let container = await filterContainers("id", containerID)
        await disconnectContainers(IS_DRAGONIFY_NETWORK_NAME[0], container[0])
      }
    }
  }
}




async function main() {
  const queue = new PQueue({concurrency: 1})
  // Create an empty array to hold the dragonifyed networks and their containers
  var networksDragonifyed: NetworksState = {}

  // Initialise Dragonify
  try {
    logger.info(`Dragonify initialising...`)
    await setUpDragonifyNetwork()
    await connectAllContainersToAppsNetwork(networksDragonifyed)
    // Flush any leftover empty networks
    await removeEmptyNetwork()
    logger.info(`Dragonify initialised.`)
    startHeartbeat()
  } catch (e: any) {
    logger.error(`Exception during initialiseDragonify:`, e)
  }
  // logger.info(`000000000 ${JSON.stringify(networksDragonifyed)}`)

  // Listen to Docker events
  const events = getEventStream(DOCKER)
  // Set a timer for execute network prune
  const resetIdleTimer = schedulePeriodicPrune(queue)


  // Handle container start events and connect container to his network labeled
  events.on("container.start", (dockerEvent) => {
    // Use the queue to ensure sequential processing
    queue.add(async () => {
      if (!isIxProjectName(dockerEvent.Attributes[IX_DOCKER_LABEL])) {
        return
      }

      // Try to connect the container from all dragonifyed networks
      logger.info(`App container starting: "${dockerEvent.Attributes["name"]}"...`)
      try {
        await containerStart(networksDragonifyed, dockerEvent["ID"])
      } catch (e: any) {
        logger.error(`Exception during containerStarting:`, e)
      }
    })
  })


  // Handle container stop events and disconnect container to his network labeled
  events.on("container.stop", (dockerEvent) => {
    // Start timer for prune network for remove empty network after container stop
    resetIdleTimer()
    // Use the queue to ensure sequential processing
    queue.add(async () => {
      if (!isIxProjectName(dockerEvent.Attributes[IX_DOCKER_LABEL])) {
        return
      }

      // Try to disconnect the container from all dragonifyed networks
      logger.info(`App container stopping: "${dockerEvent.Attributes["name"]}"...`)
      try {
        await containerStop(networksDragonifyed, `/${dockerEvent.Attributes["name"]}`)
      } catch (e: any) {
        logger.error(`Exception during containerStopping:`, e)
      }
    })
  })


  // Handle network create events and connect old container to his network labeled
  events.on("network.create", (dockerEvent) => {
    // Start timer for prune network for remove empty network after container stop
    resetIdleTimer()
    // Use the queue to ensure sequential processing
    queue.add(async () => {

      // Try to reconnect old containers that were previously connected to this network
      logger.info(`Network created: "${dockerEvent.Attributes["name"]}"...`)
      try {
        await networkCreated(networksDragonifyed, dockerEvent.Attributes["name"])
      } catch (e: any) {
        logger.error(`Exception during networkCreation:`, e)
      }
    })
  })
}

// Handle Docker shutdown to obtain an exit code: 0
function shutdown(signal: NodeJS.Signals) {
  console.log(`Received ${signal}, shutting down`);
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);


main()
