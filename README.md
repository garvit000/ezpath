# EzPath

## 1. Overview

Accessible Mobility Under Uncertainty is a navigation system designed to help people identify suitable routes through environments where accessibility information may be incomplete, outdated, or unreliable.

Traditional navigation applications primarily optimise routes based on distance, estimated travel time, and road connectivity. However, these factors alone are insufficient for individuals who depend on accessible infrastructure.

A route that appears short on a map may contain stairs, inaccessible crossings, steep slopes, obstructed footpaths, or infrastructure whose accessibility status is unknown.

This project addresses that limitation by treating accessibility as a fundamental routing constraint rather than an optional route preference.

The system analyses the available pedestrian network, evaluates accessibility-related information associated with individual paths, and calculates alternative routes while accounting for:

- Walking distance.
- Estimated travel time.
- Accessibility restrictions.
- Missing or incomplete accessibility information.
- Uncertainty associated with mapped infrastructure.
- User-specific mobility requirements.

The objective is not simply to find the shortest route. It is to identify routes that are suitable for the user's accessibility requirements while making uncertainty visible instead of silently assuming that unknown infrastructure is accessible.

The application is also being extended to support multimodal transportation, including buses and trains, to enable journeys that combine pedestrian and public transportation networks.

---

## 2. Problem Statement

People with mobility limitations frequently encounter difficulties when navigating unfamiliar environments.

Existing navigation systems generally assume that connected paths are equally usable. In practice, this assumption does not hold.

Consider a person using a wheelchair who wants to travel between two locations.

A conventional navigation application may recommend a route because it is the shortest available path. However, that route could contain:

- Staircases without ramps.
- Footpaths with insufficient accessibility information.
- Steep inclines.
- Inaccessible pedestrian crossings.
- Elevators with unknown operational status.
- Paths that may be obstructed.

The application may still recommend this route because its underlying graph considers the path traversable.

This creates a significant gap between geographical connectivity and practical accessibility.

### Core challenge

The system must determine not only whether a path exists, but also whether the path is suitable for the intended user.

An additional challenge arises when accessibility information is incomplete.

For example, if a mapped footpath does not contain information about its surface condition or wheelchair accessibility, the system cannot confidently classify it as accessible or inaccessible.

Treating missing information as positive confirmation can result in unsafe recommendations.

Therefore, the system must distinguish between:

1. Known accessible infrastructure.
2. Known inaccessible infrastructure.
3. Infrastructure with incomplete or unknown accessibility information.

This distinction forms the foundation of the routing engine.

---

## 3. Proposed Solution

The project implements an accessibility-aware routing system using geographic network data, graph-based pathfinding, and multi-objective route evaluation.

The application follows a modular architecture in which geographical data acquisition, graph processing, accessibility evaluation, route optimisation, backend communication, and frontend visualisation are handled as separate responsibilities.

At a high level, the system follows this pipeline:

```text
                 USER
                   |
                   v
        Select Source and Destination
                   |
                   v
        Select Accessibility Profile
                   |
                   v
           Frontend Application
                   |
                   v
             Backend API
                   |
                   v
        Geographic Network Retrieval
                   |
                   v
          Graph Construction
                   |
                   v
       Accessibility Classification
                   |
                   v
         Multi-Label A* Search
                   |
                   v
       Candidate Route Evaluation
                   |
                   v
        Route Reconstruction
                   |
                   v
         GeoJSON Response
                   |
                   v
         Frontend Map Rendering
                   |
                   v
       Display Routes and Metrics
```

The system is designed to preserve multiple viable route alternatives instead of returning only one route based on a single optimisation metric.

This is particularly important when two routes involve different trade-offs between travel time, distance, and accessibility uncertainty.

---

## 4. System Architecture

The application can be understood through the following major components.

### 4.1 Frontend Application

The frontend provides the interface through which users interact with the navigation system.

Its responsibilities include:

- Accepting source and destination locations.
- Collecting the user's accessibility requirements.
- Sending routing requests to the backend.
- Displaying calculated routes on an interactive map.
- Presenting route information and associated metrics.
- Communicating warnings when accessibility information is incomplete.

The frontend is responsible for visualising the results produced by the routing engine. It does not independently determine whether a geographical path is accessible.

This ensures that accessibility evaluation remains centralised in the backend.

### 4.2 Backend API

The backend acts as the communication layer between the frontend and the routing engine.

It receives navigation requests, validates the supplied parameters, invokes the routing functionality, and returns structured route information.

The backend is implemented using FastAPI.

The API layer is responsible for:

- Receiving source and destination coordinates.
- Processing routing parameters.
- Invoking the graph-based routing engine.
- Returning route geometries.
- Providing distance and travel-time information.
- Communicating uncertainty and accessibility warnings.

The routing engine is kept separate from the API layer so that the underlying graph algorithms can be developed and tested independently.

### 4.3 Geographic Data Acquisition

The system uses OpenStreetMap as its geographic data source.

OpenStreetMap provides information about pedestrian infrastructure, including:

- Footpaths.
- Pedestrian streets.
- Crossings.
- Ramps.
- Steps.
- Roads.
- Other mapped pedestrian connections.

The geographic network is retrieved and converted into a graph representation suitable for pathfinding.

An important distinction is that OpenStreetMap describes the mapped physical environment. It does not guarantee that every accessibility-related property is available or accurate.

Consequently, the absence of an accessibility tag must not automatically be interpreted as evidence that a path is accessible.

### 4.4 Graph Representation

The pedestrian network is represented using a NetworkX directed multigraph.

A directed multigraph is useful because geographical networks can contain:

- Direction-dependent connections.
- Multiple edges connecting the same pair of nodes.
- Different path characteristics between identical endpoints.
- Separate pedestrian connections with different accessibility properties.

The graph preserves the relationship between geographical nodes and the individual edges connecting them.

Each edge can contain attributes such as:

- Length.
- Estimated travel time.
- Highway or path classification.
- Surface information.
- Incline information.
- Steps or ramp indicators.
- Wheelchair accessibility tags.
- Other relevant OpenStreetMap attributes.

The routing engine evaluates these attributes before considering an edge suitable for a particular accessibility profile.

---

## 5. Accessibility Evaluation

Accessibility evaluation is one of the most important stages of the routing pipeline.

A conventional graph algorithm generally considers an edge usable if it connects two nodes.

Our system introduces an additional evaluation stage that determines whether the edge satisfies the selected accessibility requirements.

### 5.1 Accessibility Classification

The available infrastructure information is evaluated to determine its accessibility status.

The system distinguishes between:

| Classification | Meaning |
|---|---|
| Accessible | Available information supports the selected accessibility requirements. |
| Inaccessible | Available information indicates that the path violates the requirements. |
| Unknown | Available information is insufficient to confidently determine accessibility. |

This classification prevents the routing algorithm from treating every geographically connected path as equally suitable.

### 5.2 Known Inaccessible Infrastructure

Infrastructure that directly violates the user's requirements must not be considered a valid route segment under strict accessibility constraints.

For example:

- A staircase without an accessible alternative.
- A path explicitly marked as unsuitable for wheelchair users.
- Infrastructure with an accessibility restriction incompatible with the selected profile.

Such edges can be excluded from the search under the strict routing policy.

### 5.3 Unknown Infrastructure

Unknown accessibility information requires special handling.

For example, consider a footpath with no wheelchair accessibility tag.

The system cannot conclude that the path is inaccessible solely because the tag is missing. However, it also cannot confidently guarantee that the path is suitable.

Therefore, unknown infrastructure is represented as an uncertainty rather than silently treated as accessible.

This allows the routing engine to distinguish between a route supported by known accessibility information and one that depends on incomplete information.

### 5.4 Strict and Relaxed Routing Policies

The system supports different approaches to handling incomplete accessibility information.

**Strict policy**

The strict policy prioritises routes supported by known accessibility information.

Edges that are explicitly inaccessible are excluded, while unknown infrastructure is handled conservatively.

This approach is appropriate when accessibility certainty is more important than finding a route at any cost.

**Relaxed policy**

The relaxed policy allows the routing engine to explore additional alternatives involving unknown infrastructure, while retaining information about the uncertainty introduced by those edges.

This is useful when a strictly accessible route cannot be established or when the user wants to compare additional possibilities.

The important principle is that relaxing the policy must not erase uncertainty.

An unknown path must remain visibly uncertain in the returned route information.

---

## 6. Route Optimisation: Multi-Label A* Search

The routing engine uses a custom multi-label A* search algorithm.

This is an important architectural decision because accessible navigation involves multiple objectives that cannot always be represented adequately by a single shortest-path cost.

### 6.1 Why Conventional Shortest-Path Algorithms Are Insufficient

A conventional shortest-path algorithm typically attempts to minimise one accumulated cost.

For example:

```text
Route A: 400 metres, 8 minutes
Route B: 500 metres, 7 minutes
```

If the objective is purely distance minimisation, Route A is selected.

If the objective is purely travel-time minimisation, Route B is selected.

However, accessible mobility introduces additional considerations.

For example:

```text
Route A:
- Distance: 400 metres
- Time: 8 minutes
- Unknown accessibility edges: 0

Route B:
- Distance: 350 metres
- Time: 7 minutes
- Unknown accessibility edges: 3
```

Although Route B is shorter and faster, it introduces accessibility uncertainty.

A single scalar cost can hide these differences depending on how the weights are selected.

### 6.2 Multi-Label Search

Instead of maintaining only one cost value for each graph node, the algorithm maintains multiple candidate labels.

A label represents a possible route to a particular node and contains accumulated route information.

Conceptually, a label can be represented as:

```text
Label = {
    node,
    accumulated_time,
    accumulated_distance,
    accumulated_uncertainty,
    parent_label,
    traversed_edge
}
```

Each label represents a different route history.

Two routes reaching the same node may have different travel times, distances, and uncertainty values.

Discarding one route simply because another route reaches the same node first could eliminate a potentially valuable alternative.

Multi-label search avoids this limitation.

### 6.3 A* Search

A* combines the cost accumulated so far with an estimate of the remaining cost.

Its general evaluation function is:

```text
f(n) = g(n) + h(n)
```

Where:

- `g(n)` represents the accumulated cost from the starting node.
- `h(n)` represents the estimated remaining cost to the destination.
- `f(n)` determines the priority with which a candidate is explored.

In this project, the search operates over multiple labels rather than a single cost value per node.

The heuristic helps prioritise promising candidate routes while preserving the ability to explore alternatives.

### 6.4 Dominance Pruning

Maintaining multiple labels can increase computational complexity.

Many candidate labels may represent routes that are clearly inferior to other routes reaching the same node.

Dominance pruning removes such unnecessary candidates.

Consider two labels reaching the same node:

```text
Label A:
Time = 8 minutes
Distance = 400 metres
Uncertainty = 0

Label B:
Time = 10 minutes
Distance = 450 metres
Uncertainty = 2
```

Label A is better in every tracked dimension.

Therefore, Label B is dominated by Label A and does not need to be retained.

However, consider:

```text
Label A:
Time = 7 minutes
Distance = 500 metres
Uncertainty = 0

Label B:
Time = 9 minutes
Distance = 400 metres
Uncertainty = 1
```

Neither label is strictly better in every dimension.

Label A is faster and has lower uncertainty, while Label B is shorter.

Both may represent useful alternatives.

This is why the routing engine retains non-dominated labels.

### 6.5 Route Alternatives

After exploring the graph, the algorithm can return multiple non-dominated route alternatives.

Each alternative provides a different trade-off between the tracked objectives.

The frontend can then present the available routes and their characteristics rather than hiding all alternatives behind one arbitrary ranking.

---

## 7. Route Reconstruction

Once the search identifies suitable destination labels, the system reconstructs the corresponding paths.

Because the graph is a multigraph, identifying a path using only its node sequence is insufficient.

To connect the application to the deployed AWS routing backend:
1. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```
2. Update the environment variables:
   ```env
   VITE_DEMO_MODE=false
   VITE_API_BASE_URL=https://your-http-api-id.execute-api.ap-south-1.amazonaws.com
   VITE_AWS_REGION=ap-south-1
   VITE_LOCATION_MAP_NAME=EzPathSrmCampusMap
   VITE_LOCATION_API_KEY=your_referer_restricted_browser_key
   VITE_COGNITO_USER_POOL_ID=ap-south-1_replace_me
   VITE_COGNITO_CLIENT_ID=your_cognito_app_client_id
   VITE_APPSYNC_EVENTS_HTTP_URL=https://your-api-id.appsync-api.ap-south-1.amazonaws.com/event
   VITE_APPSYNC_EVENTS_REALTIME_URL=wss://your-api-id.appsync-realtime-api.ap-south-1.amazonaws.com/event/realtime
   VITE_APPSYNC_EVENTS_API_KEY=your_subscriber_key
   VITE_APPSYNC_EVENTS_CHANNEL=/disruptions/network
   ```
3. Rebuild and deploy:
   ```bash
   npm run build
   ```

Production mode plans journeys across Chennai with published metro, suburban rail and MTC bus timetables through `POST /v1/journeys`, and uses `POST /v1/routes` for trips inside the SRM campus. Times are timetabled rather than live. Metro fares come from the CMRL fare table; the bus and suburban feeds publish no fares, so those totals are shown as incomplete. The feeds publish no wheelchair-boarding data, so transit journeys are always marked unverified. Operator writes require a valid Cognito access token; demo scenario controls remain available only when `VITE_DEMO_MODE=true`.

### Constraint 10 and 12 workflow

In AWS mode, the operator console has a **Potheri lift sensor simulator** with normal, outage, missing, delayed, spike, frozen, fluctuating, and disagreement cases. These are synthetic training readings stored in the live-status table for one hour. The router checks freshness, independent source agreement, sequence progress, and state changes; no simulated reading establishes real physical accessibility.

When a traveller's profile requires lift status and a suburban journey boards or leaves rail at Potheri, the planner identifies the single missing fact: **is the Potheri lift operational?** It shows routes for comparison but withholds the affected itinerary until a real-world operator check. An authenticated operator can record an operational or outage attestation with a source note; it expires after 15 minutes. A confirmed outage keeps the affected itinerary unavailable. Strict wheelchair journeys still remain unavailable when boarding accessibility is unverified, even if the lift is confirmed operational.

The CDK stack creates manual Amplify Hosting, API Gateway CORS for the generated Amplify URL, and an Amazon Location map key restricted to map rendering from localhost and that hosted URL. It does not connect Amplify to GitHub. Follow [infra/DEPLOYMENT.md](infra/DEPLOYMENT.md) after IAM access is configured; the live deployment is managed from `infra/`.

---

## 8. GeoJSON and Map Visualisation

The routing engine returns route geometry in GeoJSON-compatible form.

GeoJSON provides a standard structure for representing geographical information.

A route can be represented as a `LineString`:

```json
{
  "type": "Feature",
  "geometry": {
    "type": "LineString",
    "coordinates": [
      [80.044, 12.823],
      [80.045, 12.824],
      [80.046, 12.825]
    ]
  },
  "properties": {
    "distance_m": 441.2,
    "estimated_time_min": 7.35,
    "uncertainty": 900
  }
}
```

The coordinate order follows the GeoJSON convention:

```text
[longitude, latitude]
```

The frontend consumes the returned geometry and renders the route on the map.

This separates route computation from route presentation.

The backend determines the path and its properties, while the frontend handles visualisation and user interaction.

---

## 9. Handling Uncertainty

Uncertainty is not treated as an implementation error or an insignificant missing value.

It is explicitly represented as part of the routing process.

This is important because accessibility information can be incomplete even when geographical information is available.

For example, the system may know that two locations are connected by a pedestrian path but have insufficient information to determine whether that path is suitable for a wheelchair.

The route can therefore be geographically valid while still having uncertain accessibility.

### Why uncertainty matters

Consider two routes:

| Metric | Route 1 | Route 2 |
|---|---:|---:|
| Distance | 441.2 m | 444.5 m |
| Estimated time | 7.35 min | 7.41 min |
| Uncertainty | 900 | 800 |
| Unknown edges | 9 | 8 |

These routes illustrate why returning only the shortest route may be misleading.

Route 1 is slightly shorter and faster, while Route 2 has fewer unknown edges and a lower uncertainty value.

Both routes involve incomplete accessibility information.

Presenting the alternatives and their uncertainty gives users more meaningful information than presenting a single route without explaining its limitations.

The numerical uncertainty values are internal evaluation metrics and should not be interpreted as calibrated probabilities of a route being inaccessible.

---

## 10. Multimodal Transportation

The project is being extended beyond pedestrian-only navigation to support journeys involving public transportation.

This extension aims to incorporate:

- Walking segments.
- Bus transportation.
- Train transportation.
- Transfers between transportation modes.
- Walking connections to and from stations or stops.

A multimodal route can be represented conceptually as:

```text
Starting Location
       |
       v
 Walking Segment
       |
       v
 Bus Stop / Train Station
       |
       v
 Public Transportation
       |
       v
 Transfer Point
       |
       v
 Walking Segment
       |
       v
 Destination
```

### 10.1 Why Multimodal Navigation Matters

For longer journeys, walking-only navigation may not be sufficient.

A person may need to walk to a nearby bus stop, travel using public transportation, and then walk to the destination.

However, the presence of a bus or train service does not automatically make the journey accessible.

The system must eventually consider accessibility across the complete journey, including:

- Accessible boarding points.
- Station and platform accessibility.
- Availability of lifts or ramps.
- Transfer distances.
- Walking connections.
- Relevant transportation schedules.

### 10.2 Transit Data Integration

Public transportation integration requires additional information beyond the pedestrian graph.

This may include:

- Stop locations.
- Route definitions.
- Trip information.
- Service calendars.
- Timetables.
- Transfer information.

Where available, General Transit Feed Specification (GTFS) data can provide a structured representation of public transportation services.

The multimodal extension is being developed separately from the existing pedestrian-routing functionality.

The intended architecture is to combine the pedestrian network with public transportation connections while retaining accessibility evaluation across the journey.

**Implementation status:** Bus and train integration is under development. The existing pedestrian-routing and map-visualisation functionality should be considered separately from this ongoing extension.

---

## 11. AWS Integration

The application already includes AWS integration as part of its overall architecture.

AWS acts as part of the application's supporting infrastructure, enabling the application to connect its backend and frontend components with the required cloud services.

The intended separation of responsibilities is:

```text
Frontend Application
        |
        v
Application Backend
        |
        v
Routing Engine
        |
        v
Route Results
        |
        v
Application Integration Layer
        |
        v
AWS-Integrated Application
```

The routing engine remains responsible for calculating routes and evaluating accessibility.

Cloud integration supports the wider application rather than replacing the graph-processing and pathfinding logic.

This separation also makes it possible to develop individual components without unnecessarily changing the existing routing implementation.

---

## 12. Surprise Constraint: The Sensors Are Lying

An additional challenge associated with the project is the possibility that sensor information cannot always be trusted.

In a real-world accessible mobility environment, infrastructure information may be obtained from sensors monitoring lifts, ramps, crossings, or other facilities.

However, sensors can fail or report incorrect information.

For example:

- A sensor may stop sending readings.
- A sensor may report an abnormal value.
- A sensor may become stuck and repeatedly report the same value.
- Multiple sensors may report conflicting information.
- Old readings may arrive after newer readings.
- A sensor may produce unusually fluctuating measurements.

If such readings are accepted without validation, the application could make incorrect operational decisions.

### 12.1 Proposed Solution: Simulated Sensor Reliability and Admin Verification

The project will address this constraint through a standalone software-based sensor simulation and anomaly-monitoring component.

The implementation will use dummy sensor feeds rather than physical sensor hardware.

This allows the team to reproduce sensor failures in a controlled environment and demonstrate how the application responds to unreliable information.

The planned architecture is:

```text
       Dummy Sensor Generator
                 |
                 v
          Simulated Readings
                 |
                 v
          Sensor Validator
                 |
                 v
          Anomaly Detector
                 |
                 v
          Fault Classification
                 |
                 v
          Admin Alert Interface
                 |
                 v
          Human Verification
                 |
                 v
          Verified Resolution
```

### 12.2 Simulated Fault Categories

The dummy sensor environment will reproduce six categories of faults.

| Fault | Simulation |
|---|---|
| Missing readings | Stop sending readings from a sensor for a configurable period. |
| Sudden spikes | Generate a reading significantly different from recent observations. |
| Repeated values | Send the same numeric value repeatedly to simulate a stuck sensor. |
| Unusual fluctuations | Generate readings with abnormal variation over a rolling window. |
| Delayed or out-of-order data | Send older observations after newer readings have already arrived. |
| Conflicting sensors | Generate inconsistent readings from multiple sensors monitoring the same asset and metric. |

### 12.3 Anomaly Detection

The detector will evaluate incoming readings using configurable rules.

Examples include:

- Comparing the last-seen timestamp against a stale timeout.
- Comparing a new value against recent historical observations.
- Detecting repeated numeric values.
- Measuring the variation in a rolling window.
- Comparing observation and reception timestamps.
- Comparing independent sensor readings for the same asset.

Each detected anomaly will generate a structured alert.

### 12.4 Admin Alert Interface

Detected anomalies will be forwarded to a dedicated administrative interface.

The interface will display information such as:

- Sensor identifier.
- Associated infrastructure or asset.
- Fault category.
- Reported reading.
- Previous or expected reading.
- Observation timestamp.
- Alert severity.
- Verification status.

Administrators will be able to review and classify alerts.

Possible actions include:

- Acknowledge an alert.
- Confirm a suspected sensor fault.
- Mark a reading as a genuine operational event.
- Request physical verification.
- Resolve an alert.

### 12.5 Human-in-the-Loop Decision-Making

A critical design decision is that suspicious sensor readings will not automatically modify route availability.

A sensor anomaly is evidence that a reading may be unreliable. It is not proof that the associated infrastructure is operational or unavailable.

Therefore, the system will require human verification before a verified operational update is considered by the wider application.

This prevents a faulty simulated reading from directly causing an incorrect navigation recommendation.

### 12.6 Separation from Existing Routing

The sensor-monitoring component will remain independent of the existing pedestrian-routing engine and AWS-integrated application.

Its responsibility is to identify suspicious information and communicate it to administrators.

The existing routing functionality will not be modified merely because a sensor produces an abnormal reading.

This separation preserves the stability of the existing application while providing a controlled demonstration of sensor reliability handling.

**Implementation status:** Planned. The dummy sensor generator, fault injection, anomaly detection, and admin alert workflow will be implemented after the primary navigation application is completed.

---

## 13. Testing and Validation

The project requires testing at multiple levels to verify that the routing engine and its supporting components behave as expected.

### 13.1 Geographic Data Testing

Validate that:

- Geographic network data can be retrieved.
- The graph contains the expected nodes and edges.
- Directional connectivity is preserved.
- Parallel edges are handled correctly.
- Required edge attributes are available for accessibility evaluation.

### 13.2 Accessibility Testing

Test the classification of:

- Known accessible paths.
- Known inaccessible paths.
- Paths with missing accessibility information.

Verify that strict and relaxed policies handle unknown infrastructure differently and that inaccessible paths are not incorrectly accepted under strict constraints.

### 13.3 Routing Algorithm Testing

Test the routing engine using graphs containing:

- A single valid route.
- Multiple alternative routes.
- Multiple edges between the same nodes.
- Routes with different distances.
- Routes with different travel times.
- Routes with different uncertainty levels.
- Nodes reached through dominated and non-dominated labels.

Verify that dominance pruning removes inferior labels without eliminating useful alternatives.

### 13.4 Route Reconstruction Testing

Verify that:

- The reconstructed route follows the edges explored during search.
- Multigraph edge keys are preserved.
- The output coordinates follow the GeoJSON longitude-latitude convention.
- The generated geometry can be consumed by the frontend.

### 13.5 Frontend Integration Testing

Verify that:

- Source and destination selections are processed correctly.
- Routing requests reach the backend.
- The frontend receives valid route information.
- Route geometries are rendered correctly.
- Alternative routes and their associated metrics are displayed.

### 13.6 Multimodal Testing

As bus and train integration is developed, additional tests should validate:

- Walking connections to transit stops.
- Transit route selection.
- Transfer handling.
- Schedule constraints.
- Accessibility of boarding and transfer infrastructure.

### 13.7 Sensor Constraint Testing

Once the planned sensor module is implemented, each injected fault must have a corresponding expected detection result.

The test environment should verify that:

- Normal readings do not generate unnecessary alerts.
- Injected faults are detected.
- Alerts contain the correct sensor and asset information.
- Delayed readings do not overwrite newer observations.
- Conflicting readings generate review requests.
- Unverified anomalies do not automatically modify route availability.

---

## 14. Design Principles

The project follows several important engineering principles.

### Accessibility Before Convenience

A route should not be considered suitable merely because it is short or fast.

Accessibility requirements must be evaluated during route computation.

### Explicit Uncertainty

Missing information must remain distinguishable from confirmed accessibility.

The system should communicate limitations rather than silently making assumptions.

### Multiple Route Alternatives

Different users may value distance, time, and accessibility certainty differently.

Returning non-dominated alternatives allows users to make informed decisions.

### Separation of Responsibilities

Geographic data processing, accessibility evaluation, graph search, API communication, map rendering, and sensor monitoring are maintained as separate responsibilities.

This makes the system easier to test, extend, and maintain.

### Conservative Operational Decisions

Unverified sensor readings must not automatically determine whether infrastructure is available.

Suspicious information should be reviewed before operational decisions are changed.

### Extensibility

The architecture is designed to support additional transportation modes and dynamic infrastructure information without requiring the entire routing engine to be redesigned.

---

## 15. Current Implementation Status

The following table distinguishes the existing functionality from ongoing and planned work.

| Component | Status |
|---|---|
| OpenStreetMap geographic data usage | Implemented |
| Pedestrian graph construction | Implemented |
| Accessibility-aware edge evaluation | Implemented |
| Strict and relaxed accessibility handling | Implemented |
| Multi-label A* routing | Implemented |
| Dominance pruning | Implemented |
| Route reconstruction | Implemented |
| GeoJSON route output | Implemented |
| FastAPI backend | Implemented |
| Frontend walking route visualisation | Implemented |
| AWS application integration | Integrated |
| Bus transportation support | Under development |
| Train transportation support | Under development |
| Dummy sensor generator | Planned |
| Sensor fault injection | Planned |
| Sensor anomaly detection | Planned |
| Admin alert interface for sensor anomalies | Planned |
| Human verification workflow | Planned |

The implementation status should be updated as individual components are completed and tested.

---

## 16. Future Improvements

Several extensions can further improve the system.

### Improved Accessibility Data

Incorporate richer accessibility information, including:

- Ramp gradients.
- Footpath widths.
- Surface conditions.
- Curb heights.
- Crossing characteristics.
- Elevator availability.

### Real-Time Infrastructure Monitoring

The planned simulated sensor environment can eventually be extended to consume actual infrastructure telemetry if suitable hardware and data sources become available.

### Improved Multimodal Routing

Develop a unified routing model that evaluates pedestrian and public transportation segments together.

### Personalised Accessibility Profiles

Support different mobility requirements, allowing the system to adjust edge evaluation and route selection according to the user's needs.

### Better Uncertainty Modelling

Explore more sophisticated approaches to representing incomplete, conflicting, and time-sensitive accessibility information.

### Performance Optimisation

Improve graph retrieval, caching, search efficiency, and route computation for larger geographical environments.

---

## 17. Conclusion

Accessible Mobility Under Uncertainty aims to address an important limitation of conventional navigation systems: geographical connectivity does not necessarily imply practical accessibility.

By incorporating accessibility-aware graph evaluation, multi-label A* search, dominance pruning, and explicit uncertainty representation, the system moves beyond conventional shortest-path navigation.

The architecture also supports expansion into multimodal transportation and a future sensor reliability layer.

The central design principle is simple:

**A navigation system should not merely identify a path between two locations. It should evaluate whether that path is suitable for the person travelling, communicate what is known and unknown, and avoid presenting uncertain information as a guarantee of accessibility.**
