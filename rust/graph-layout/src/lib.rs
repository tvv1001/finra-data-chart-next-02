use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

#[derive(Deserialize)]
struct NodeInput {
    id: String,
    x: Option<f64>,
    y: Option<f64>,
    r: Option<f64>,
    #[serde(default, rename = "locX")]
    loc_x: Option<f64>,
    #[serde(default, rename = "locY")]
    loc_y: Option<f64>,
    #[serde(default, rename = "locStrength")]
    loc_strength: Option<f64>,
}

#[derive(Deserialize)]
struct LinkInput {
    source: String,
    target: String,
}

#[derive(Serialize)]
struct PositionOutput {
    id: String,
    x: f64,
    y: f64,
}

#[wasm_bindgen]
pub fn compute_layout(nodes_json: &str, links_json: &str, width: f64, height: f64) -> Result<String, JsError> {
    let nodes: Vec<NodeInput> = serde_json::from_str(nodes_json).unwrap_or_default();
    let links: Vec<LinkInput> = serde_json::from_str(links_json).unwrap_or_default();

    let mut state: Vec<(f64, f64, f64, f64, f64, f64)> = nodes
        .iter()
        .map(|n| {
            let x = n.x.unwrap_or(width / 2.0);
            let y = n.y.unwrap_or(height / 2.0);
            let r = n.r.unwrap_or(6.0);
            (x, y, 0.0, 0.0, r, n.loc_strength.unwrap_or(0.0))
        })
        .collect();

    let desired_link_length = 70.0;
    let link_strength = 0.015;
    let repulsion_strength = 1800.0;
    let damping = 0.86;

    for _ in 0..8 {
        let mut forces = vec![(0.0, 0.0); state.len()];

        #[cfg(feature = "parallel")]
        {
            use rayon::prelude::*;
            let n = state.len();
            let computed: Vec<(f64, f64)> = (0..n)
                .into_par_iter()
                .map(|i| {
                    let (x, y, _, _, r, _) = state[i];
                    let mut fx = 0.0;
                    let mut fy = 0.0;
                    for j in 0..n {
                        if i == j { continue; }
                        let (ox, oy, _, _, or, _) = state[j];
                        let dx = x - ox;
                        let dy = y - oy;
                        let dist2 = dx * dx + dy * dy + 12.0;
                        let force = repulsion_strength / dist2;
                        fx += (dx / dist2) * force;
                        fy += (dy / dist2) * force;
                        if (r + or) > 0.0 {
                            let push = (r + or) * 0.02;
                            fx += dx.signum() * push / (1.0 + (dist2 / 1600.0).sqrt());
                            fy += dy.signum() * push / (1.0 + (dist2 / 1600.0).sqrt());
                        }
                    }
                    (fx, fy)
                })
                .collect();
            forces = computed;
        }

        #[cfg(not(feature = "parallel"))]
        {
            for i in 0..state.len() {
                let (x, y, _, _, r, _) = state[i];
                let mut fx = 0.0;
                let mut fy = 0.0;

                for j in 0..state.len() {
                    if i == j { continue; }
                    let (ox, oy, _, _, or, _) = state[j];
                    let dx = x - ox;
                    let dy = y - oy;
                    let dist2 = dx * dx + dy * dy + 12.0;
                    let force = repulsion_strength / dist2;
                    fx += (dx / dist2) * force;
                    fy += (dy / dist2) * force;
                    if (r + or) > 0.0 {
                        let push = (r + or) * 0.02;
                        fx += dx.signum() * push / (1.0 + (dist2 / 1600.0).sqrt());
                        fy += dy.signum() * push / (1.0 + (dist2 / 1600.0).sqrt());
                    }
                }

                forces[i].0 += fx;
                forces[i].1 += fy;
            }
        }

        for link in &links {
            let a = nodes.iter().position(|n| n.id == link.source);
            let b = nodes.iter().position(|n| n.id == link.target);
            if let (Some(a_idx), Some(b_idx)) = (a, b) {
                let (ax, ay, _, _, _, _) = state[a_idx];
                let (bx, by, _, _, _, _) = state[b_idx];
                let dx = bx - ax;
                let dy = by - ay;
                let dist = (dx * dx + dy * dy).sqrt().max(1.0);
                let diff = dist - desired_link_length;
                let spring = diff * link_strength;
                let nx = (dx / dist) * spring;
                let ny = (dy / dist) * spring;
                forces[a_idx].0 -= nx;
                forces[a_idx].1 -= ny;
                forces[b_idx].0 += nx;
                forces[b_idx].1 += ny;
            }
        }

        for i in 0..state.len() {
            let (x, y, vx, vy, r, loc_strength) = state[i];
            let mut fx = forces[i].0;
            let mut fy = forces[i].1;

            if loc_strength > 0.0 {
                let loc_x = nodes[i].loc_x.unwrap_or(width / 2.0);
                let loc_y = nodes[i].loc_y.unwrap_or(height / 2.0);
                fx += (loc_x - x) * 0.003 * loc_strength;
                fy += (loc_y - y) * 0.003 * loc_strength;
            } else {
                fx += (width / 2.0 - x) * 0.004;
                fy += (height / 2.0 - y) * 0.004;
            }

            let mut nvx = vx + fx * 0.02;
            let mut nvy = vy + fy * 0.02;
            nvx *= damping;
            nvy *= damping;
            state[i] = (x + nvx, y + nvy, nvx, nvy, r, loc_strength);
        }
    }

    let positions = state
        .into_iter()
        .enumerate()
        .map(|(index, (x, y, _, _, _, _))| PositionOutput {
            id: nodes[index].id.clone(),
            x,
            y,
        })
        .collect::<Vec<_>>();

    serde_json::to_string(&positions).map_err(|e| JsError::new(&e.to_string()))
}
