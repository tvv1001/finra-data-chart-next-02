use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct GraphSimulation {
    positions: Vec<f64>,
    velocities: Vec<f64>,
    r: Vec<f64>,
    loc_strength: Vec<f64>,
    loc_x: Vec<f64>,
    loc_y: Vec<f64>,
    source_indices: Vec<usize>,
    target_indices: Vec<usize>,
    width: f64,
    height: f64,
}

#[wasm_bindgen]
impl GraphSimulation {
    #[wasm_bindgen(constructor)]
    pub fn new(width: f64, height: f64) -> GraphSimulation {
        GraphSimulation {
            positions: Vec::new(),
            velocities: Vec::new(),
            r: Vec::new(),
            loc_strength: Vec::new(),
            loc_x: Vec::new(),
            loc_y: Vec::new(),
            source_indices: Vec::new(),
            target_indices: Vec::new(),
            width,
            height,
        }
    }

    pub fn add_node(&mut self, x: f64, y: f64, r: f64, loc_strength: f64, loc_x: f64, loc_y: f64) {
        self.positions.push(x);
        self.positions.push(y);
        self.velocities.push(0.0);
        self.velocities.push(0.0);
        self.r.push(r);
        self.loc_strength.push(loc_strength);
        self.loc_x.push(loc_x);
        self.loc_y.push(loc_y);
    }

    pub fn add_link(&mut self, source: usize, target: usize) {
        self.source_indices.push(source);
        self.target_indices.push(target);
    }

    pub fn update_node(&mut self, index: usize, x: f64, y: f64) {
        if index * 2 + 1 < self.positions.len() {
            self.positions[index * 2] = x;
            self.positions[index * 2 + 1] = y;
        }
    }
    
    pub fn update_size(&mut self, width: f64, height: f64) {
        self.width = width;
        self.height = height;
    }

    pub fn tick(&mut self, iterations: usize) {
        let n = self.r.len();
        let desired_link_length = 70.0;
        let link_strength = 0.015;
        let repulsion_strength = 1800.0;
        let damping = 0.86;

        for _ in 0..iterations {
            let mut fx = vec![0.0; n];
            let mut fy = vec![0.0; n];

            // Calculate repulsion
            for i in 0..n {
                let xi = self.positions[i * 2];
                let yi = self.positions[i * 2 + 1];
                let ri = self.r[i];
                let mut fix = 0.0;
                let mut fiy = 0.0;

                for j in 0..n {
                    if i == j { continue; }
                    let dx = xi - self.positions[j * 2];
                    let dy = yi - self.positions[j * 2 + 1];
                    let dist2 = dx * dx + dy * dy + 12.0;
                    let force = repulsion_strength / dist2;
                    
                    fix += (dx / dist2) * force;
                    fiy += (dy / dist2) * force;
                    
                    let rj = self.r[j];
                    if (ri + rj) > 0.0 {
                        let push = (ri + rj) * 0.02;
                        let root = (1.0 + dist2 / 1600.0).sqrt();
                        fix += dx.signum() * push / root;
                        fiy += dy.signum() * push / root;
                    }
                }
                fx[i] = fix;
                fy[i] = fiy;
            }

            // Calculate links
            for i in 0..self.source_indices.len() {
                let s = self.source_indices[i];
                let t = self.target_indices[i];
                let dx = self.positions[t * 2] - self.positions[s * 2];
                let dy = self.positions[t * 2 + 1] - self.positions[s * 2 + 1];
                let dist = (dx * dx + dy * dy).sqrt().max(1.0);
                let diff = dist - desired_link_length;
                let spring = diff * link_strength;
                let nx = (dx / dist) * spring;
                let ny = (dy / dist) * spring;

                fx[s] -= nx;
                fy[s] -= ny;
                fx[t] += nx;
                fy[t] += ny;
            }

            // Apply forces
            for i in 0..n {
                if self.loc_strength[i] > 0.0 {
                    fx[i] += (self.loc_x[i] - self.positions[i * 2]) * 0.003 * self.loc_strength[i];
                    fy[i] += (self.loc_y[i] - self.positions[i * 2 + 1]) * 0.003 * self.loc_strength[i];
                } else {
                    fx[i] += (self.width / 2.0 - self.positions[i * 2]) * 0.004;
                    fy[i] += (self.height / 2.0 - self.positions[i * 2 + 1]) * 0.004;
                }

                self.velocities[i * 2] = (self.velocities[i * 2] + fx[i] * 0.02) * damping;
                self.velocities[i * 2 + 1] = (self.velocities[i * 2 + 1] + fy[i] * 0.02) * damping;
                
                self.positions[i * 2] += self.velocities[i * 2];
                self.positions[i * 2 + 1] += self.velocities[i * 2 + 1];
            }
        }
    }

    pub fn get_positions(&self) -> Vec<f64> {
        self.positions.clone()
    }
}
