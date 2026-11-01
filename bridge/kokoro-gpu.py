# kokoro-gpu.py in.onnx out.onnx: Kokoro's fp16 model (onnx-community/
# Kokoro-82M-v1.0-ONNX, onnx/model_fp16.onnx) as ONNX Runtime's WebGPU EP
# gets it right (checked on a Radeon 840M, RADV, onnxruntime-node 1.30):
#
#  - ConvTranspose with stride 3, 6, 7 or 12 comes out as little but its
#    bias (2, 4, 5, 8, 9, 10, 16 are fine), so each 1-D one is s-1 zeros
#    after each input step and then a Conv with the kernel flipped and its
#    channels swapped, padded k-1-p; the same numbers, to 1e-5.
#  - The vocoder's phase is atan(imag / real), and where both underflow to
#    0 in fp16 that's NaN; a bin with no magnitude has no phase, so 0.
#  - ReduceMean sums in fp16, and AdaIN's mean of squares over a few
#    thousand steps passes 65504, so each is done in fp32.

import sys
import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper, shape_inference

m = onnx.load(sys.argv[1])
g = m.graph
inits = {i.name: i for i in g.initializer}


def const(name, arr):
    g.initializer.append(numpy_helper.from_array(np.array(arr, dtype=np.int64), name))
    return name


nodes = []
for n in g.node:
    a = {x.name: helper.get_attribute_value(x) for x in n.attribute}
    if n.op_type != "ConvTranspose" or len(a.get("kernel_shape", [])) != 1 or a.get("group", 1) != 1 \
            or a.get("dilations", [1]) != [1] or a.get("output_padding", [0]) != [0]:
        nodes.append(n)
        continue
    s, k, p = a["strides"][0], a["kernel_shape"][0], a.get("pads", [0, 0])
    x, w, y = n.input[0], n.input[1], n.output[0]
    W = numpy_helper.to_array(inits[w])
    g.initializer.append(numpy_helper.from_array(np.ascontiguousarray(np.flip(W.transpose(1, 0, 2), 2)), w + "_conv"))
    src = x
    if s > 1:
        src = y + "_stuffed"
        nodes.append(helper.make_node("Unsqueeze", [x, const(y + "_ax3", [3])], [y + "_u"]))
        nodes.append(helper.make_node("Pad", [y + "_u", const(y + "_pads", [0, 0, 0, 0, 0, 0, 0, s - 1])], [y + "_z"]))
        nodes.append(helper.make_node("Reshape", [y + "_z", const(y + "_shape", [0, 0, -1])], [y + "_r"]))
        nodes.append(helper.make_node("Slice", [y + "_r", const(y + "_st", [0]), const(y + "_en", [-(s - 1)]), const(y + "_ax2", [2])], [src]))
    nodes.append(helper.make_node("Conv", [src, w + "_conv"] + list(n.input[2:]), [y], name=n.name + "_as_conv", kernel_shape=[k], pads=[k - 1 - p[0], k - 1 - p[1]]))

D = "/decoder/decoder/generator/Div_output_0"
assert any(n.op_type == "Atan" and D in n.input for n in nodes)
for n in nodes:
    for i, x in enumerate(n.input):
        if x == D:
            n.input[i] = D + "_finite"
g.initializer.append(numpy_helper.from_array(np.zeros((), np.float16), D + "_zero"))
i = next(i for i, n in enumerate(nodes) if D in n.output)
nodes[i + 1:i + 1] = [helper.make_node("Equal", [D, D], [D + "_isnum"]),
                      helper.make_node("Where", [D + "_isnum", D, D + "_zero"], [D + "_finite"])]
del g.node[:]
g.node.extend(nodes)

m = shape_inference.infer_shapes(m)
g = m.graph
types = {v.name: v.type.tensor_type.elem_type for v in list(g.value_info) + list(g.input) + list(g.output)}
nodes = []
for n in g.node:
    if n.op_type == "ReduceMean" and types.get(n.input[0]) == TensorProto.FLOAT16:
        x, y = n.input[0], n.output[0]
        nodes.append(helper.make_node("Cast", [x], [y + "_in32"], to=TensorProto.FLOAT))
        n.input[0], n.output[0] = y + "_in32", y + "_out32"
        nodes.append(n)
        nodes.append(helper.make_node("Cast", [y + "_out32"], [y], to=TensorProto.FLOAT16))
    else:
        nodes.append(n)
del g.node[:]
g.node.extend(nodes)
del g.value_info[:]
onnx.save(m, sys.argv[2])
