"""The exact semantic configurations the installed reading renderer can draw."""
from copy import deepcopy
import re
from .storage import StoreError

CONTRACTS = {
    "mux": {"config": {"selectBits": ["S1", "S0"], "dataSignals": ["0", "¬z", "1", "z"]},
            "inputs": {"S1": 0, "S0": 0, "z": 0},
            "limits": "仅2:1或4:1。选择位从高到低；数据端数等于2的选择位数次方。数据端仅0、1、输入名或¬输入名。"},
    "decoder": {"config": {"addressBits": ["A2", "A1", "A0"], "outputs": 8,
                 "activeLowOutputs": True, "enable": {"S1": 1, "S2": 0, "S3": 0}},
                "inputs": {"A2": 0, "A1": 0, "A0": 0, "S1": 1, "S2": 0, "S3": 0},
                "limits": "仅74LS138三线八线低有效输出；地址从高到低，三个使能端一高有效、两低有效。"},
    "kmap": {"config": {"columnOrder": ["00", "01", "11", "10"],
              "cells": [[1, 0, 0, 1], [1, 0, 0, 1]], "highlight": "wrap-four"},
             "inputs": {"showCorners": 0},
             "limits": "当前仅支持这个A/BC跨边四格示例，不能替换cells、坐标或圈组规则。其他函数可以添加文字/公式解释。"},
}


def component_contracts():
    return deepcopy(CONTRACTS)


def validate_component(payload):
    if not isinstance(payload,dict):
        raise StoreError("invalid_content", "交互内容必须是对象")
    component, config, inputs = payload.get("component"), payload.get("config"), payload.get("inputs")
    valid = isinstance(config, dict) and isinstance(inputs, dict) and all(
        isinstance(k, str) and re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*", k)
        and type(v) in (int, bool) and v in (0, 1) for k, v in (inputs or {}).items())
    def names(value, lengths):
        return isinstance(value,list) and len(value) in lengths and all(isinstance(n,str) and n in inputs for n in value) and len(set(value))==len(value)
    if valid and component == "mux":
        bits, signals = config.get("selectBits"), config.get("dataSignals")
        valid = names(bits,(1,2)) and isinstance(signals,list) and len(signals)==2**len(bits)
        if valid:
            valid=all(isinstance(s,str) and (s in ("0","1") or s.removeprefix("¬") in inputs) for s in signals)
    elif valid and component == "decoder":
        enable=config.get("enable")
        valid=(names(config.get("addressBits"),(3,)) and config.get("outputs")==8 and config.get("activeLowOutputs") is True
               and isinstance(enable,dict) and len(enable)==3 and set(enable)<=set(inputs)
               and all(type(v) in (int,bool) and v in (0,1) for v in enable.values())
               and sum(enable.values())==1 and not set(enable)&set(config["addressBits"]))
    elif valid and component == "kmap":
        template=CONTRACTS["kmap"]["config"]
        valid=all(config.get(k)==v for k,v in template.items()) and set(inputs)=={"showCorners"}
    else:
        valid=False
    if not valid:
        raise StoreError("capability_unavailable", "该交互配置尚不能正确绘制，请使用已支持配置或改为文字和公式解释",
                         {"component":component,"supportedComponents":component_contracts()})


def validate_changed_components(previous, desired):
    def walk(entity):
        result={}
        def visit(items):
            if not isinstance(items,list):
                raise StoreError("invalid_content", "正文块必须是数组")
            for block in items:
                if not isinstance(block,dict) or not isinstance(block.get("id"),str):
                    raise StoreError("invalid_content", "正文块缺少稳定身份")
                result[block["id"]]=block
                visit(block.get("children",[]))
        visit((entity.get("reading") or {}).get("blocks",[]))
        return result
    before=walk(previous or {})
    for identifier,block in walk(desired).items():
        if block.get("kind")=="interactive" and block.get("payload")!=before.get(identifier,{}).get("payload"):
            validate_component(block["payload"])
